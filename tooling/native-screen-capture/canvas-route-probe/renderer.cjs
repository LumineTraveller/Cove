'use strict';
// Serialized into a sandboxed, non-COI owned page. No Node, handles or pixel logs.
module.exports = function setupCanvasRoute(requestId, config) {
  const {width,height,frames,poolSize}=config;
  const now=()=>performance.now();
  const need=(yes,code)=>{if(!yes)throw new Error(code);};
  const safe=error=>/^[a-z0-9_]{1,100}$/.test(error?.message)?error.message:'canvas_renderer_failed';
  const state={status:'waiting',errorCode:null,result:{inputs:[],outputs:[],warmupOutputs:0,duplicateOutputs:0,
    maxInputCallbacks:0,maxCopyPromises:0,outputFormats:[],outputColorSpaces:[],processorQueueLimit:3,
    canvasPendingLimit:null,canvasPendingLimitPubliclyAvailable:false,inputFrames:frames,
    copyBuffer:'ArrayBuffer',copyFormatOptionOmitted:true,sourceFrameClosedAfterDraw:true}};
  window.__coveCanvasRoute=state;
  let canvas,context,track,reader,unsubscribe,reading,closed=false,callbacks=0,pending=0,buffer=null,lastSerial=0;
  const inputs=new Map(),outputs=new Set();
  const memory=()=>performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize}:null;
  const colorInfo=frame=>{const c=frame.colorSpace;return{primaries:c?.primaries??null,transfer:c?.transfer??null,matrix:c?.matrix??null,fullRange:c?.fullRange??null};};
  const frameInfo=frame=>({format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,
    displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,colorSpace:colorInfo(frame)});
  function fail(error){state.errorCode||=safe(error);state.status='failed';}
  function pixel(x,y,serial) {
    if(y<2&&x<16){const g=(serial>>Math.floor(x/2))&1?224:32;return[g,g,g];}
    x=Math.floor(x*64/width);y=Math.floor(y*64/height);
    const colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,255],[0,0,0],[0,255,255],[255,0,255],[255,255,0]];
    if(y>=24&&y<40){const g=[0,32,64,96,128,160,192,255][Math.floor(x/8)];return[g,g,g];}
    if(y>=44&&y<52)return colors[Math.floor(x/8)];
    if(y>=52&&y<60)return colors[(y%2)*2+x%2];
    return colors[(y>=32?2:0)+(x>=32?1:0)];
  }
  function layoutCheck(format,layout,bytes) {
    const geometry=format==='NV12'?[[width,height],[width,height/2]]:[[width,height],[width/2,height/2],[width/2,height/2]];
    need(Array.isArray(layout)&&layout.length===geometry.length,'canvas_output_layout_invalid');
    const ranges=layout.map((p,index)=>{const [row,h]=geometry[index];
      need(Number.isSafeInteger(p.offset)&&p.offset>=0&&Number.isSafeInteger(p.stride)&&p.stride>=row,'canvas_output_layout_invalid');
      const end=p.offset+p.stride*(h-1)+row;need(Number.isSafeInteger(end)&&end<=bytes,'canvas_output_layout_invalid');return[p.offset,end];});
    for(let a=0;a<ranges.length;a++)for(let b=a+1;b<ranges.length;b++)need(ranges[a][1]<=ranges[b][0]||ranges[b][1]<=ranges[a][0],'canvas_output_layout_overlap');
  }
  function validate(bytes,layout,format,serial,color) {
    // The output metadata selects a fixed documented matrix/range. Unknown or
    // inconsistent metadata fails; do not fit an oracle to observed pixels.
    need(color.fullRange===false&&((format==='NV12'&&color.matrix==='bt709')||(format==='I420'&&color.matrix==='smpte170m')),'canvas_output_color_contract_unsupported');
    const kr=color.matrix==='bt709'?.2126:.299,kb=color.matrix==='bt709'?.0722:.114;
    const quantize=v=>Math.floor(Math.max(0,Math.min(255,v))+.5);
    const yuv=p=>{const [r,g,b]=p.map(v=>v/255),y=kr*r+(1-kr-kb)*g+kb*b;
      return[quantize(16+219*y),quantize(128+224*(b-y)/(2*(1-kb))),quantize(128+224*(r-y)/(2*(1-kr)))];};
    // Every selected color marker is inside a uniform 2x2 source region.
    const markers=[[8,8],[56,8],[8,62],[56,62],[36,48],[12,32],[36,32],[52,32],
      [4,48],[12,48],[20,48],[28,48],[44,48],[52,48],[60,48]]
      .map(([x,y])=>[Math.floor(x*width/64/2)*2,Math.floor(y*height/64/2)*2]);
    let maximumError=0,count=0;
    for(const [x,y] of [...Array.from({length:8},(_,bit)=>[bit*2,0]),...markers]) {
      const expected=yuv(pixel(x,y,serial));
      for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
        maximumError=Math.max(maximumError,Math.abs(bytes[layout[0].offset+(y+dy)*layout[0].stride+x+dx]-expected[0]));count++;
      }
      const u=format==='NV12'?layout[1].offset+(y/2)*layout[1].stride+x:layout[1].offset+(y/2)*layout[1].stride+x/2;
      const v=format==='NV12'?u+1:layout[2].offset+(y/2)*layout[2].stride+x/2;
      maximumError=Math.max(maximumError,Math.abs(bytes[u]-expected[1]),Math.abs(bytes[v]-expected[2]));count+=2;
    }
    // Shader RGB->YUV and libyuv fixed point conversion may round by one code.
    return{passed:maximumError<=1,maximumError,sampleCount:count,tolerance:1,
      oracle:'metadata-selected BT.601/BT.709 limited raw YUV; no YUV-to-RGB inverse'};
  }
  async function readOutputs() {
    while(!closed) {
      const packet=await reader.read();if(packet.done)break;const frame=packet.value;
      let copying=false;
      try {
        const receivedAtMs=now(),info=frameInfo(frame),format=info.format;
        need(['NV12','I420'].includes(format)&&info.codedWidth===width&&info.codedHeight===height&&
          info.displayWidth===width&&info.displayHeight===height,'canvas_output_format_or_size_mismatch');
        const bytes=frame.allocationSize();need(Number.isSafeInteger(bytes)&&bytes>=width*height*1.5&&bytes<=width*height*4,'canvas_output_allocation_invalid');
        if(!buffer||buffer.byteLength!==bytes)buffer=new ArrayBuffer(bytes);
        const callAtMs=now();const promise=frame.copyTo(buffer);const callReturnedAtMs=now();copying=true;
        pending++;state.result.maxCopyPromises=Math.max(state.result.maxCopyPromises,pending);
        let layout;
        try{layout=await promise;}finally{pending--;copying=false;}
        const settledAtMs=now();layoutCheck(format,layout,bytes);const data=new Uint8Array(buffer);
        let serial=0;for(let bit=0;bit<8;bit++)if(data[layout[0].offset+bit*2]>128)serial|=1<<bit;
        if(serial===0){
          need(state.result.outputs.length===0&&state.result.warmupOutputs===0,'canvas_unexpected_blank_output');
          for(const [x,y]of [[0,0],[width-2,0],[0,height-2],[width-2,height-2]]){
            need(Math.abs(data[layout[0].offset+y*layout[0].stride+x]-16)<=1,'canvas_initial_blank_pixels_invalid');
          }
          state.result.warmupOutputs++;continue;
        }
        need(inputs.has(serial)&&serial<=frames,'canvas_unknown_pixel_sequence');
        const colorKey=JSON.stringify(info.colorSpace);
        if(!state.result.outputFormats.includes(format))state.result.outputFormats.push(format);
        if(!state.result.outputColorSpaces.some(c=>JSON.stringify(c)===colorKey))state.result.outputColorSpaces.push(info.colorSpace);
        state.result.firstOutputMetadata??=info;
        const check=validate(data,layout,format,serial,info.colorSpace);
        if(!check.passed)state.result.failedOutput={serial,metadata:info,pixels:check};
        need(check.passed,'canvas_output_pixels_mismatch');
        need(serial>=lastSerial,'canvas_output_sequence_regressed');lastSerial=serial;
        const input=inputs.get(serial);
        const sample={serial,receivedAtMs,settledAtMs,outputTimestampUs:frame.timestamp,
          frameAgeMs:receivedAtMs-input.drawAtMs,sourceToCopyCompleteAgeMs:settledAtMs-input.drawAtMs,
          copyCallWallMs:callReturnedAtMs-callAtMs,copyPromiseWallMs:settledAtMs-callAtMs,
          copyPostCallWallMs:settledAtMs-callReturnedAtMs,bytes,layout:layout.map(p=>({offset:p.offset,stride:p.stride})),pixels:check};
        if(outputs.has(serial))state.result.duplicateOutputs++;else{outputs.add(serial);state.result.outputs.push(sample);}
        state.result.lastOutputAtMs=settledAtMs;
      } catch(error){fail(error);throw error;} finally {
        // Never erase memory, close the output frame, or return before the real
        // copy settles. There is no timeout race around copyTo().
        if(!copying){if(buffer?.byteLength)new Uint8Array(buffer).fill(0);frame.close();}
      }
    }
  }
  function inputFrame(frame,metadata) {
    callbacks++;state.result.maxInputCallbacks=Math.max(state.result.maxInputCallbacks,callbacks);
    try {
      need(!closed&&state.status!=='failed'&&callbacks<=poolSize,'canvas_input_callback_invalid');
      need(metadata?.requestId===requestId&&metadata.width===width&&metadata.height===height&&
        Number.isInteger(metadata.serial)&&metadata.serial>0&&metadata.serial<=frames&&!inputs.has(metadata.serial)&&
        Number.isInteger(metadata.slot)&&metadata.slot>=0&&metadata.slot<poolSize,'canvas_input_metadata_invalid');
      const info=frameInfo(frame),color=info.colorSpace;
      need(info.format==='BGRA'&&info.codedWidth===width&&info.codedHeight===height&&frame.timestamp===metadata.timestamp&&
        color.primaries==='bt709'&&color.transfer==='iec61966-2-1'&&color.matrix==='rgb'&&color.fullRange===true,'canvas_input_color_or_format_mismatch');
      const input={serial:metadata.serial,slot:metadata.slot,receivedAtMs:now(),drawAtMs:now()};
      // Request this real frame before the draw. Every native frame arrives in
      // its own IPC task; no requestFrame burst or fabricated frame credits.
      track.requestFrame();const started=now();context.drawImage(frame,0,0,width,height);
      input.drawWallMs=now()-started;input.drawReturnedAtMs=now();
      inputs.set(metadata.serial,input);state.result.inputs.push(input);state.result.inputMetadata??=info;
      state.status='running';
    } catch(error){fail(error);}
    finally {
      // The canvas may still retain a GPU reference. Native slot reuse is solely
      // the main process's original Electron allReferencesReleased barrier.
      frame?.close();callbacks--;
    }
  }
  window.__coveCanvasRouteCleanup=async()=>{
    closed=true;unsubscribe?.();unsubscribe=null;track?.stop();
    try{await reader?.cancel();}catch{}
    await reading;
    try{reader?.releaseLock();}catch{}
    reader=null;track=null;
    canvas?.remove();canvas=null;context=null;if(buffer?.byteLength)new Uint8Array(buffer).fill(0);buffer=null;
    state.result.memoryAfter=memory();
    return{callbacks,pendingCopies:pending,readerStopped:true,canvasRemoved:true,copyBufferReleased:true,status:state.status,errorCode:state.errorCode};
  };
  const supported=!!(window.coveNativeScreen?.supported&&typeof window.coveNativeScreen.onFrame==='function'&&
    typeof MediaStreamTrackProcessor==='function'&&typeof VideoFrame==='function');
  try {
    need(supported,'canvas_renderer_api_unavailable');need(crossOriginIsolated===false,'canvas_non_coi_page_required');
    state.result.memoryBefore=memory();canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;document.body.append(canvas);
    context=canvas.getContext('2d',{alpha:false,willReadFrequently:false});need(context,'canvas_context_unavailable');
    const attributes=context.getContextAttributes();need(attributes.alpha===false&&attributes.willReadFrequently===false,'canvas_context_attributes_mismatch');
    state.result.contextAttributes={alpha:attributes.alpha,willReadFrequently:attributes.willReadFrequently,colorSpace:attributes.colorSpace??null};
    const stream=canvas.captureStream(0);track=stream.getVideoTracks()[0];need(track&&typeof track.requestFrame==='function','canvas_request_frame_unavailable');
    track.contentHint='detail';const processor=new MediaStreamTrackProcessor({track,maxBufferSize:3});reader=processor.readable.getReader();
    reading=readOutputs().catch(error=>{if(!closed)fail(error);});
    unsubscribe=window.coveNativeScreen.onFrame(requestId,inputFrame);
  } catch(error){fail(error);}
  return{supported,crossOriginIsolated,nodeType:typeof require,sharedArrayBufferType:typeof SharedArrayBuffer,
    processorAvailable:typeof MediaStreamTrackProcessor==='function',contextAttributes:state.result.contextAttributes,status:state.status,errorCode:state.errorCode};
};
