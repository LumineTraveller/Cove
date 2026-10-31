'use strict';
// Serialized into the isolated owned page. No Node, IPC or native handles.
module.exports = function setupReadback(requestId, config, createColorOracle) {
  const { width, height, pixelFormat, bufferKind, frames, inflight } = config;
  const state = { status: 'waiting', errorCode: null, result: { samples: [], completed: 0,
    maxCopyPromises: 0, maxCallbacks: 0, pixelsPassed: true, sequencePassed: true,
    bufferKind, copyOptions: {}, expectedFrames: frames, cpuGolden: null } };
  window.__coveReadbackProbe = state;
  const bridge = window.coveNativeScreen;
  let closed = false, active = 0, pending = 0, unsubscribe;
  const tasks = new Set(), seen = new Set(), slots = new Set();
  const need = (condition, code) => { if (!condition) throw new Error(code); };
  const errorCode = error => /^[a-z0-9_]{1,100}$/.test(error?.message) ? error.message : 'renderer_readback_failed';
  const now = () => performance.now();
  const supported = !!(bridge?.supported && typeof bridge.onFrame === 'function' && typeof VideoFrame === 'function');
  const isolated = crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
  const colorOracle=createColorOracle();
  function source(x, y, serial) {
    if (y < 2 && x < 16) { const value = serial & (1 << Math.floor(x / 2)) ? 224 : 32; return [value,value,value,255]; }
    x = Math.floor(x * 64 / width); y = Math.floor(y * 64 / height);
    const colors = [[0,0,255,255],[0,255,0,255],[255,0,0,255],[255,255,255,255],
      [0,0,0,255],[255,255,0,255],[255,0,255,255],[0,255,255,255]];
    if (y >= 24 && y < 40) { const g = [0,32,64,96,128,160,192,255][Math.floor(x/8)]; return [g,g,g,255]; }
    if (y >= 44 && y < 52) return colors[Math.floor(x/8)];
    if (y >= 52 && y < 60) return colors[(y%2)*2+x%2];
    return colors[(y>=32 ? 2 : 0)+(x>=32 ? 1 : 0)];
  }
  const quantize = value => Math.floor(Math.max(0,Math.min(255,value))+.5);
  function yuv(pixel) {
    const r=pixel[2]/255,g=pixel[1]/255,b=pixel[0]/255, y=.2126*r+.7152*g+.0722*b;
    return [16+219*y,128+224*(b-y)/(2*(1-.0722)),128+224*(r-y)/(2*(1-.2126))];
  }
  const markers = [[8,8],[56,8],[8,62],[56,62],[36,48],[12,32],[36,32],[52,32],
    [4,48],[12,48],[20,48],[28,48],[44,48],[52,48],[60,48],[14,54]]
    .map(([x,y]) => [Math.floor(x*width/64/2)*2,Math.floor(y*height/64/2)*2]);
  const points = [...Array.from({length:8},(_,bit)=>[bit*2,0]),...markers];
  function layoutValid(layout, bytes) {
    const planes = pixelFormat === 'nv12' ? 2 : 1;
    need(Array.isArray(layout) && layout.length === planes,'renderer_layout_invalid');
    const rowBytes = pixelFormat === 'nv12' ? width : width*4;
    const ends = layout.map((plane,index) => {
      need(Number.isSafeInteger(plane.offset) && plane.offset >= 0 && Number.isSafeInteger(plane.stride) && plane.stride >= rowBytes,'renderer_layout_invalid');
      const end=plane.offset+plane.stride*((index===1?height/2:height)-1)+rowBytes;
      need(Number.isSafeInteger(end) && end<=bytes,'renderer_layout_invalid'); return end;
    });
    if (planes===2) need(ends[0]<=layout[1].offset || ends[1]<=layout[0].offset,'renderer_layout_invalid');
  }
  function validate(buffer, layout, serial) {
    const bytes = new Uint8Array(buffer); let maximumError=0,sampleCount=0,decoded=0;
    for (let pointIndex=0;pointIndex<points.length;++pointIndex) {
      const [x,y]=points[pointIndex];
      for(let dy=0;dy<2;++dy) for(let dx=0;dx<2;++dx) {
        const pixel=source(x+dx,y+dy,serial);
        if(pixelFormat==='bgra') {
          for(let channel=0;channel<4;++channel) { maximumError=Math.max(maximumError,Math.abs(bytes[layout[0].offset+(y+dy)*layout[0].stride+(x+dx)*4+channel]-pixel[channel])); ++sampleCount; }
        } else { maximumError=Math.max(maximumError,Math.abs(bytes[layout[0].offset+(y+dy)*layout[0].stride+x+dx]-quantize(yuv(pixel)[0]))); ++sampleCount; }
      }
      if(pixelFormat==='nv12') {
        const average=[0,0,0,255];
        for(let dy=0;dy<2;++dy) for(let dx=0;dx<2;++dx) { const p=source(x+dx,y+dy,serial); for(let c=0;c<3;++c) average[c]+=p[c]/4; }
        const expected=yuv(average),offset=layout[1].offset+(y/2)*layout[1].stride+x;
        for(let channel=0;channel<2;++channel) { maximumError=Math.max(maximumError,Math.abs(bytes[offset+channel]-quantize(expected[channel+1]))); ++sampleCount; }
      }
      if(pointIndex<8) {
        const offset=layout[0].offset+y*layout[0].stride+(pixelFormat==='nv12'?x:x*4);
        if(bytes[offset]>128) decoded|=1<<pointIndex;
      }
    }
    const tolerance=pixelFormat==='nv12'?1:0;
    return { maximumError,sampleCount,tolerance,sequencePassed:decoded===serial,passed:maximumError<=tolerance&&decoded===serial };
  }
  async function cpuGolden(buffer,layout,metadata) {
    // SAB is never transferable. Make the AB copy explicit and time it.
    const copyStarted=now();
    const ab=bufferKind==='sab'?new Uint8Array(buffer).slice().buffer:buffer;
    const sabToArrayBufferWallMs=now()-copyStarted;
    const color=pixelFormat==='nv12'?{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}
      :{primaries:'bt709',transfer:'iec61966-2-1',matrix:'rgb',fullRange:true};
    let cpu; const constructStarted=now();
    const measurement={passed:false,format:pixelFormat.toUpperCase(),sampleCount:0,maximumRgbError:0,
      tolerance:pixelFormat==='nv12'?4:0,oracle:pixelFormat==='nv12'?{id:colorOracle.id,revision:colorOracle.revision,
        constants:colorOracle.constants,source:colorOracle.source,sourceSha256:colorOracle.sourceSha256,sourceHashObject:colorOracle.sourceHashObject,
        localCrlfSnapshotSha256:colorOracle.localCrlfSnapshotSha256,dependencySource:colorOracle.dependencySource}:{id:'original-bgra-code-values-v1'},
      originalSourceComparison:{maximumError:0,tolerance:pixelFormat==='nv12'?4:0,passed:false},fixedSyntheticSamples:[],
      sabToArrayBufferCopy:bufferKind==='sab',sabToArrayBufferWallMs,transferAttempted:true};
    // Keep diagnostics even if the post-readback CPU RGB oracle fails. Raw copy
    // success is independent of this separate conversion correctness check.
    state.result.cpuGolden=measurement;
    try {
      cpu=new VideoFrame(ab,{format:pixelFormat.toUpperCase(),codedWidth:width,codedHeight:height,
        displayWidth:width,displayHeight:height,timestamp:metadata.timestamp,layout,colorSpace:color,transfer:[ab]});
      measurement.constructWallMs=now()-constructStarted;measurement.constructTransferDetached=ab.byteLength===0;
      need(cpu.format===pixelFormat.toUpperCase()&&cpu.codedWidth===width&&cpu.codedHeight===height,'renderer_cpu_metadata_mismatch');
      for(const [markerIndex,[x,y]] of markers.slice(0,8).entries()) {
        const options={format:'RGBA',colorSpace:'srgb',rect:{x,y,width:2,height:2}};
        const rgba=new Uint8Array(cpu.allocationSize(options));
        const rgbLayout=await cpu.copyTo(rgba,options);
        need(rgbLayout.length===1&&rgbLayout[0].stride>=8&&rgbLayout[0].offset+rgbLayout[0].stride+8<=rgba.length,'renderer_cpu_rgb_layout_invalid');
        for(let dy=0;dy<2;++dy) for(let dx=0;dx<2;++dx) {
          const original=source(x+dx,y+dy,metadata.serial),offset=rgbLayout[0].offset+dy*rgbLayout[0].stride+dx*4;
          let expected=[original[2],original[1],original[0],255],expectedYuv=null;
          if(pixelFormat==='nv12') {
            // Predict quantized shader YUV from the owned source pattern,
            // independently of the bytes returned by GPU copyTo().
            const average=[0,0,0,255],blockX=(x+dx)&~1,blockY=(y+dy)&~1;
            for(let by=0;by<2;++by)for(let bx=0;bx<2;++bx){const p=source(blockX+bx,blockY+by,metadata.serial);for(let c=0;c<3;++c)average[c]+=p[c]/4;}
            const chroma=yuv(average);expectedYuv=[quantize(yuv(original)[0]),quantize(chroma[1]),quantize(chroma[2])];
            expected=colorOracle.nv12ToRgba(...expectedYuv);
          }
          for(let c=0;c<3;++c) {
            measurement.maximumRgbError=Math.max(measurement.maximumRgbError,Math.abs(rgba[offset+c]-expected[c]));
            measurement.originalSourceComparison.maximumError=Math.max(measurement.originalSourceComparison.maximumError,Math.abs(rgba[offset+c]-original[2-c]));
            measurement.sampleCount++;
          }
          if(dx===0&&dy===0)measurement.fixedSyntheticSamples.push({marker:markerIndex,expectedYuv,
            originalRgb:[original[2],original[1],original[0]],expectedRgb:expected.slice(0,3),actualRgb:Array.from(rgba.subarray(offset,offset+3))});
          need(rgba[offset+3]===255,'renderer_cpu_alpha_mismatch');
        }
        rgba.fill(0);
      }
      measurement.originalSourceComparison.passed=measurement.originalSourceComparison.maximumError<=measurement.originalSourceComparison.tolerance;
      need(measurement.maximumRgbError<=measurement.tolerance,'renderer_cpu_rgb_mismatch');
      measurement.passed=true;return measurement;
    } finally { cpu?.close();measurement.frameClosedAfterChecks=!!cpu;if(ab.byteLength)new Uint8Array(ab).fill(0); }
  }
  async function callback(frame,metadata) {
    let buffer; let sample; let copySettled=false;
    active++; state.result.maxCallbacks=Math.max(state.result.maxCallbacks,active);
    try {
      need(!closed&&active<=inflight,'renderer_inflight_limit');
      need(metadata?.requestId===requestId&&metadata.width===width&&metadata.height===height&&
        Number.isInteger(metadata.serial)&&metadata.serial>0&&metadata.serial<=frames&&
        Number.isInteger(metadata.slot)&&metadata.slot>=0&&metadata.slot<inflight&&!slots.has(metadata.slot)&&!seen.has(metadata.serial),'renderer_sequence_metadata_invalid');
      seen.add(metadata.serial); slots.add(metadata.slot);
      need(frame?.format===pixelFormat.toUpperCase()&&frame.codedWidth===width&&frame.codedHeight===height&&frame.timestamp===metadata.timestamp,'renderer_gpu_metadata_mismatch');
      const color=frame.colorSpace;
      need(color?.primaries==='bt709'&&color.transfer===(pixelFormat==='nv12'?'bt709':'iec61966-2-1')&&
        color.matrix===(pixelFormat==='nv12'?'bt709':'rgb')&&color.fullRange===(pixelFormat==='bgra'),'renderer_gpu_color_mismatch');
      state.result.inputMetadata??={format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,
        colorSpace:{primaries:color.primaries,transfer:color.transfer,matrix:color.matrix,fullRange:color.fullRange}};
      const allocationStarted=now(),bytes=frame.allocationSize();
      need(Number.isSafeInteger(bytes)&&bytes>0&&bytes<=width*height*4,'renderer_allocation_invalid');
      buffer=bufferKind==='sab'?new SharedArrayBuffer(bytes):new ArrayBuffer(bytes);
      const allocationWallMs=now()-allocationStarted;
      const callAt=now(); let copying;
      try { copying=frame.copyTo(buffer); }
      catch(error) { copySettled=true; throw error; }
      const callReturnedAt=now();
      pending++; state.result.maxCopyPromises=Math.max(state.result.maxCopyPromises,pending);
      // No timeout races here: keep the real input lease until real completion.
      let layout;
      try { layout=await copying; }
      finally { copySettled=true; pending--; }
      const settledAt=now();
      sample={serial:metadata.serial,slot:metadata.slot,bytes,allocationWallMs,
        copyCallWallMs:callReturnedAt-callAt,copyPromiseWallMs:settledAt-callAt,
        copyPostCallWallMs:settledAt-callReturnedAt,callAtMs:callAt,settledAtMs:settledAt};
      state.result.completed++;
      layoutValid(layout,bytes);sample.layout=layout.map(plane=>({offset:plane.offset,stride:plane.stride}));const validateStarted=now();
      sample.pixels=validate(buffer,layout,metadata.serial); sample.validationWallMs=now()-validateStarted;
      state.result.pixelsPassed&&=sample.pixels.passed; state.result.sequencePassed&&=sample.pixels.sequencePassed;
      need(sample.pixels.passed,'renderer_pixels_mismatch');
      state.result.samples.push(sample);
      // One native-plane CPU construction plus RGB golden per matrix cell.
      if(metadata.serial===1) state.result.cpuGolden=await cpuGolden(buffer,layout,metadata);
    } catch(error) { state.errorCode ||= errorCode(error); state.status='failed'; }
    finally {
      // All writes have settled before erase or callback return. The product
      // preload closes its VideoFrame only after this awaited callback returns.
      if(buffer?.byteLength && copySettled)new Uint8Array(buffer).fill(0);
      slots.delete(metadata?.slot); active--;
      if(state.status!=='failed'&&active===0&&pending===0&&state.result.samples.length===frames) {
        state.result.samples.sort((a,b)=>a.serial-b.serial); state.result.passed=state.result.pixelsPassed&&state.result.sequencePassed&&state.result.cpuGolden?.passed===true;
        state.status=state.result.passed?'complete':'failed';
      }
    }
  }
  window.__coveReadbackCleanup=async()=>{
    closed=true; unsubscribe?.(); unsubscribe=null;
    // Closing a window/session aborts processing, but never fabricates a copy
    // completion or native released ACK. Retain writes until their real settle.
    await Promise.allSettled([...tasks]);
    return {active,pending,callbacksDrained:tasks.size===0};
  };
  if(supported&&isolated) unsubscribe=bridge.onFrame(requestId,(frame,metadata)=>{
    const task=callback(frame,metadata); tasks.add(task); task.finally(()=>tasks.delete(task)); return task;
  });
  else {state.status='failed';state.errorCode=isolated?'renderer_bridge_unavailable':'renderer_cross_origin_isolation_required';}
  return {supported,isolated,crossOriginIsolated,sharedArrayBufferType:typeof SharedArrayBuffer,
    nodeType:typeof require,bufferKind,copyFormatOptionOmitted:true};
};
