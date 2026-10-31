'use strict';
// Executes the actual product module's default browser boundary. No replacement
// Canvas platform, task scheduler, credits or product pixel-marker dependency.
module.exports = function setupProductCanvasRoute(requestId, config, product) {
  const {width,height,frames,poolSize}=config;
  const now=()=>performance.now();
  const need=(yes,code)=>{if(!yes)throw new Error(code);};
  const safe=error=>/^[a-z0-9_]{1,100}$/.test(error?.message)?error.message:'canvas_product_renderer_failed';
  const state={status:'waiting',errorCode:null,result:{inputs:[],outputs:[],warmupOutputs:0,duplicateOutputs:0,
    maxInputCallbacks:0,maxCopyPromises:0,outputFormats:[],outputColorSpaces:[],inputFrames:frames,
    sourceFrameClosedAfterSubmitSettlement:true,copyBuffer:'ArrayBuffer',copyFormatOptionOmitted:true,
    product:{sourceStart:config.productSourceStart??'after-prime',actualDefaultPlatform:true,primed:false,receipts:[],submissions:[],
      startup:{timeOriginMs:performance.timeOrigin,moduleCreateStartedAtMs:null,moduleCreatedAtMs:null,
        primeReadyAtMs:null,firstInputAtMs:null,firstInputBeforePrime:null,firstInputModulePhase:null,inputsBeforePrime:0},
      writtenSerials:[],writes:[],onWritten:[],dropNotifications:[],moduleFailures:[],generatorSettings:null,
      pendingSubmissions:0,maxPendingSubmissions:0,validationCopies:0,maxWrites:0,
      validationBeforeGeneratorWrite:true,validationAddsFullFrameCopy:true,productPixelMarkersRequired:false,
      modulePrivateDrainObservable:false,moduleSnapshots:[],productionEligible:false}}};
  window.__coveCanvasRoute=state;
  let sink,generator,writer,unsubscribe,closed=false,callbacks=0,pendingCopies=0,pendingWrites=0,writerClosed=false;
  let buffer=null,lastWrittenSerial=0;
  const inputByTimestamp=new Map(),outputSerials=new Set(),submissions=new Set(),writeOperations=new Set();
  const memory=()=>performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize}:null;
  const colorInfo=frame=>{const c=frame.colorSpace;return{primaries:c?.primaries??null,transfer:c?.transfer??null,matrix:c?.matrix??null,fullRange:c?.fullRange??null};};
  const frameInfo=frame=>({format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,
    displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,colorSpace:colorInfo(frame)});
  const settings=()=>{const s=generator.getSettings();return{width:s.width??null,height:s.height??null,frameRate:s.frameRate??null};};
  function snapshot(label){if(typeof sink?.snapshot==='function')try{
    state.result.product.moduleSnapshots.push({label,atMs:now(),value:sink.snapshot()});
  }catch{state.result.product.snapshotReadFailed=true;}}
  function fail(error){state.errorCode||=safe(error);state.status='failed';snapshot('failure');sink?.stop();}
  function layoutCheck(layout,bytes){
    need(Array.isArray(layout)&&layout.length===2,'canvas_product_layout_invalid');
    const ranges=layout.map((p,n)=>{need(Number.isSafeInteger(p.offset)&&p.offset>=0&&Number.isSafeInteger(p.stride)&&p.stride>=width,'canvas_product_layout_invalid');
      const end=p.offset+p.stride*((n?height/2:height)-1)+width;need(Number.isSafeInteger(end)&&end<=bytes,'canvas_product_layout_invalid');return[p.offset,end];});
    need(ranges[0][1]<=ranges[1][0]||ranges[1][1]<=ranges[0][0],'canvas_product_layout_overlap');
  }
  function pixel(x,y,serial){
    if(y<2&&x<16){const g=(serial>>Math.floor(x/2))&1?224:32;return[g,g,g];}
    x=Math.floor(x*64/width);y=Math.floor(y*64/height);
    const colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,255],[0,0,0],[0,255,255],[255,0,255],[255,255,0]];
    if(y>=24&&y<40){const g=[0,32,64,96,128,160,192,255][Math.floor(x/8)];return[g,g,g];}
    if(y>=44&&y<52)return colors[Math.floor(x/8)];if(y>=52&&y<60)return colors[(y%2)*2+x%2];
    return colors[(y>=32?2:0)+(x>=32?1:0)];
  }
  function validate(data,layout,serial){
    const q=v=>Math.floor(Math.max(0,Math.min(255,v))+.5);
    const yuv=p=>{const [r,g,b]=p.map(v=>v/255),y=.2126*r+.7152*g+.0722*b;
      return[q(16+219*y),q(128+224*(b-y)/(2*(1-.0722))),q(128+224*(r-y)/(2*(1-.2126)))];};
    const markers=[[8,8],[56,8],[8,62],[56,62],[36,48],[12,32],[36,32],[52,32],
      [4,48],[12,48],[20,48],[28,48],[44,48],[52,48],[60,48]].map(([x,y])=>[Math.floor(x*width/64/2)*2,Math.floor(y*height/64/2)*2]);
    let maximumError=0,count=0;
    for(const[x,y]of[...Array.from({length:8},(_,bit)=>[bit*2,0]),...markers]){
      const expected=yuv(pixel(x,y,serial));
      for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){maximumError=Math.max(maximumError,Math.abs(data[layout[0].offset+(y+dy)*layout[0].stride+x+dx]-expected[0]));count++;}
      const u=layout[1].offset+y/2*layout[1].stride+x;
      maximumError=Math.max(maximumError,Math.abs(data[u]-expected[1]),Math.abs(data[u+1]-expected[2]));count+=2;
    }
    return{passed:maximumError<=1,maximumError,sampleCount:count,tolerance:1,oracle:'fixed BT.709 limited raw NV12; fixture serial only'};
  }
  async function write(frame){
    pendingWrites++;state.result.product.maxWrites=Math.max(state.result.product.maxWrites,pendingWrites);
    const receivedAtMs=now(),info=frameInfo(frame),color=info.colorSpace,writerFrameTimestampUs=frame.timestamp;
    try{
      need(pendingWrites===1,'canvas_product_writer_overlap');
      need(info.format==='NV12'&&info.codedWidth===width&&info.codedHeight===height&&info.displayWidth===width&&info.displayHeight===height&&
        color.primaries==='bt709'&&color.transfer==='bt709'&&color.matrix==='bt709'&&color.fullRange===false,'canvas_product_writer_contract');
      const input=inputByTimestamp.get(writerFrameTimestampUs);need(input,'canvas_product_native_timestamp_mismatch');
      const bytes=frame.allocationSize();need(Number.isSafeInteger(bytes)&&bytes>=width*height*1.5&&bytes<=width*height*4,'canvas_product_allocation_invalid');
      if(!buffer||buffer.byteLength!==bytes)buffer=new ArrayBuffer(bytes);
      const callAtMs=now();let callReturnedAtMs,layout;
      pendingCopies++;state.result.maxCopyPromises=Math.max(state.result.maxCopyPromises,pendingCopies);state.result.product.validationCopies++;
      try{const copying=frame.copyTo(buffer);callReturnedAtMs=now();layout=await copying;}finally{pendingCopies--;}
      const settledAtMs=now();layoutCheck(layout,bytes);const data=new Uint8Array(buffer);
      let serial=0;for(let bit=0;bit<8;bit++)if(data[layout[0].offset+bit*2]>128)serial|=1<<bit;
      need(serial===input.serial,'canvas_product_pixel_timestamp_mismatch');
      const check=validate(data,layout,serial);need(check.passed,'canvas_product_output_pixels_mismatch');
      need(serial>lastWrittenSerial&&!outputSerials.has(serial),'canvas_product_duplicate_or_regressed_output');
      // No new output may reach Generator once the owned module was retired.
      if(closed||state.status==='failed')return;
      const writeCalledAtMs=now();await writer.write(frame);const writeSettledAtMs=now();
      lastWrittenSerial=serial;outputSerials.add(serial);
      state.result.product.writes.push({serial,writerFrameTimestampUs,writeCalledAtMs,writeSettledAtMs,
        writeWallMs:writeSettledAtMs-writeCalledAtMs,validationWallMs:settledAtMs-callAtMs,totalWallMs:writeSettledAtMs-receivedAtMs});
      state.result.product.writtenSerials.push(serial);state.result.product.generatorSettings=settings();
      state.result.outputs.push({serial,receivedAtMs,settledAtMs,outputTimestampUs:writerFrameTimestampUs,
        frameAgeMs:receivedAtMs-input.receivedAtMs,sourceToCopyCompleteAgeMs:settledAtMs-input.receivedAtMs,
        ageBasis:'native receipt; module draw time is private',copyCallWallMs:callReturnedAtMs-callAtMs,
        copyPromiseWallMs:settledAtMs-callAtMs,copyPostCallWallMs:settledAtMs-callReturnedAtMs,bytes,
        layout:layout.map(p=>({offset:p.offset,stride:p.stride})),pixels:check});
      if(!state.result.outputFormats.includes(info.format))state.result.outputFormats.push(info.format);
      if(!state.result.outputColorSpaces.length)state.result.outputColorSpaces.push(color);
      state.result.firstOutputMetadata??=info;
    }catch(error){fail(error);throw error;}finally{pendingWrites--;if(buffer?.byteLength)new Uint8Array(buffer).fill(0);}
  }
  function observedWrite(frame){const operation=write(frame);writeOperations.add(operation);operation.then(()=>writeOperations.delete(operation),()=>writeOperations.delete(operation));return operation;}
  function inputFrame(frame,metadata){
    callbacks++;state.result.maxInputCallbacks=Math.max(state.result.maxInputCallbacks,callbacks);
    const receivedAtMs=now();
    const p=state.result.product,s=p.startup;
    if(s.firstInputAtMs===null){s.firstInputAtMs=receivedAtMs;s.firstInputBeforePrime=!p.primed;
      s.firstInputModulePhase=typeof sink?.snapshot==='function'?sink.snapshot().phase:null;}
    if(!p.primed)s.inputsBeforePrime++;
    const operation=(async()=>{
      try{
        need(!closed&&state.status!=='failed'&&callbacks<=poolSize,'canvas_product_input_callback_invalid');
        need(metadata?.requestId===requestId&&metadata.width===width&&metadata.height===height&&Number.isInteger(metadata.serial)&&
          metadata.serial>0&&metadata.serial<=frames&&Number.isInteger(metadata.slot)&&metadata.slot>=0&&metadata.slot<poolSize&&
          Number.isSafeInteger(metadata.timestamp)&&!inputByTimestamp.has(metadata.timestamp),'canvas_product_input_metadata_invalid');
        const info=frameInfo(frame),color=info.colorSpace;
        need(info.format==='BGRA'&&info.codedWidth===width&&info.codedHeight===height&&frame.timestamp===metadata.timestamp&&
          color.primaries==='bt709'&&color.transfer==='iec61966-2-1'&&color.matrix==='rgb'&&color.fullRange===true,'canvas_product_input_contract');
        const input={serial:metadata.serial,slot:metadata.slot,sourceTimestampUs:metadata.timestamp,receivedAtMs};
        inputByTimestamp.set(metadata.timestamp,input);state.result.product.receipts.push({serial:metadata.serial,receivedAtMs});
        // Deliberately no await before submit: preserve the product call topology.
        const result=await sink.submit(frame,metadata.timestamp),settledAtMs=now();
        state.result.product.submissions.push({serial:metadata.serial,result,settledAtMs});
        if(result==='drawn')state.result.inputs.push({...input,drawAtMs:settledAtMs,drawWallMs:null,drawTimeBasis:'submit settled after synchronous draw'});
        else need(['superseded','expired','stopped'].includes(result),'canvas_product_submit_result_invalid');
      }catch(error){fail(error);}finally{try{frame.close();}finally{callbacks--;}}
    })();
    submissions.add(operation);state.result.product.pendingSubmissions=submissions.size;
    state.result.product.maxPendingSubmissions=Math.max(state.result.product.maxPendingSubmissions,submissions.size);
    operation.then(()=>{submissions.delete(operation);state.result.product.pendingSubmissions=submissions.size;},()=>{});
    return operation;
  }
  window.__coveCanvasRouteCleanup=async()=>{
    closed=true;unsubscribe?.();unsubscribe=null;snapshot('before_cleanup');sink?.stop();
    await Promise.allSettled([...submissions]);await Promise.allSettled([...writeOperations]);
    if(writer){try{await writer.close();writerClosed=true;}catch(error){fail(error);}try{writer.releaseLock();}catch{}}
    if(generator){state.result.product.generatorSettings=settings();generator.stop();}
    if(buffer?.byteLength)new Uint8Array(buffer).fill(0);buffer=null;
    snapshot('after_cleanup');state.result.memoryAfter=memory();
    return{callbacks,pendingCopies,pendingWrites,pendingInputFrames:submissions.size,moduleStopCalled:!!sink,
      modulePrivateDrainObservable:false,readerStopped:null,writerClosed,copyBufferReleased:true,status:state.status,errorCode:state.errorCode};
  };
  const supported=!!(window.coveNativeScreen?.supported&&typeof window.coveNativeScreen.onFrame==='function'&&
    typeof MediaStreamTrackProcessor==='function'&&typeof MediaStreamTrackGenerator==='function'&&typeof MessageChannel==='function'&&typeof VideoFrame==='function'&&
    typeof product?.createNativeCanvasFrameSink==='function'&&typeof product?.getNativeCanvasFrameFailureCode==='function');
  try{
    need(supported,'canvas_product_api_unavailable');need(crossOriginIsolated===false,'canvas_non_coi_page_required');
    need(config.canvasPlacement==='detached','canvas_product_uses_actual_detached_platform');
    state.result.memoryBefore=memory();generator=new MediaStreamTrackGenerator({kind:'video'});generator.contentHint='detail';writer=generator.writable.getWriter();
    state.result.product.startup.moduleCreateStartedAtMs=now();
    sink=product.createNativeCanvasFrameSink({width,height,fps:120,writer:{write:observedWrite},
      onWritten(writeMs,queueAgeMs){state.result.product.onWritten.push({atMs:now(),writeMs,queueAgeMs});
        if(state.result.product.onWritten.length===1)snapshot('after_first_write');},
      onDropped(reason){state.result.product.dropNotifications.push({atMs:now(),reason});},
      onFailure(error){const code=product.getNativeCanvasFrameFailureCode(error);state.result.product.moduleFailures.push({atMs:now(),code});fail(new Error('canvas_product_'+code));}});
    state.result.product.startup.moduleCreatedAtMs=now();
    snapshot('after_create');unsubscribe=window.coveNativeScreen.onFrame(requestId,inputFrame);if(state.status!=='failed')state.status='priming';
    sink.ready.then(ready=>{if(closed||state.status==='failed')return;need(ready===true,'canvas_product_not_ready');
      state.result.product.primed=true;state.result.product.primeReadyAtMs=now();
      state.result.product.startup.primeReadyAtMs=state.result.product.primeReadyAtMs;snapshot('after_ready');state.status='ready';}).catch(fail);
  }catch(error){fail(error);}
  return{supported,crossOriginIsolated,nodeType:typeof require,sharedArrayBufferType:typeof SharedArrayBuffer,
    processorAvailable:typeof MediaStreamTrackProcessor==='function',status:state.status,errorCode:state.errorCode};
};
