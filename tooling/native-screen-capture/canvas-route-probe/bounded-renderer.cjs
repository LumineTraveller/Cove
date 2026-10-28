'use strict';
// Separate finite admission experiment; legacy mechanism/paced stay unchanged.
// Serialized into a sandboxed, non-COI owned page. No Node, handles or pixel logs.
module.exports = function setupBoundedCanvasRoute(requestId, config) {
  const {width,height,frames,poolSize}=config;
  const sinkMode=config.boundedSink??'direct';
  const canvasPlacement=config.canvasPlacement??'attached';
  const now=()=>performance.now();
  const need=(yes,code)=>{if(!yes)throw new Error(code);};
  const safe=error=>/^[a-z0-9_]{1,100}$/.test(error?.message)?error.message:'canvas_renderer_failed';
  const state={status:'waiting',errorCode:null,result:{inputs:[],outputs:[],warmupOutputs:0,duplicateOutputs:0,
    maxInputCallbacks:0,maxCopyPromises:0,outputFormats:[],outputColorSpaces:[],processorQueueLimit:1,
    canvasPendingLimit:null,canvasPendingLimitPubliclyAvailable:false,inputFrames:frames,
    copyBuffer:'ArrayBuffer',copyFormatOptionOmitted:true,sourceFrameClosedAfterDraw:true,
    bounded:{sinkMode,writerUsed:sinkMode!=='none',primed:false,maxCanvasAdmissions:0,maxPendingInputs:0,maxWrites:0,creditsGranted:0,
      receipts:[],supersededSerials:[],cancelledSerials:[],completedSerials:[],writtenSerials:[],writes:[],
      cpuFramesConstructed:0,copyBuffersTransferred:0,sourceOutputsClosedBeforeWrite:0,constructorSamples:[],generatorSettings:null,
      creditRule:'strictly-new Canvas timestamp + fixture serial matches sole active draw + selected sink real completion',
      publicCanvasPendingBound:false,productPixelMarkersRequired:false,generatorIsOnlyRtpCandidate:true,
      pendingAdmissionTask:false,maxPendingAdmissionTasks:0,admissionTaskPosts:0}}};
  window.__coveCanvasRoute=state;
  let canvas,context,track,reader,unsubscribe,reading,generator,writer,writerClosed=sinkMode==='none'?null:false,closed=false,callbacks=0,pending=0,buffer=null,lastSerial=0;
  let active=null,pendingInput=null,writes=0,lastTimestamp=null,deadlineTimer=null,admissionChannel=null,admissionScheduled=false;
  const inputs=new Map(),outputs=new Set();
  const memory=()=>performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize}:null;
  const colorInfo=frame=>{const c=frame.colorSpace;return{primaries:c?.primaries??null,transfer:c?.transfer??null,matrix:c?.matrix??null,fullRange:c?.fullRange??null};};
  const frameInfo=frame=>({format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,
    displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,colorSpace:colorInfo(frame)});
  function settleInput(item,reason) {
    if(!item||item.settled)return;item.settled=true;
    try{item.frame.close();}finally{callbacks--;item.resolve();}
    if(reason)state.result.bounded[reason].push(item.metadata.serial);
  }
  function fail(error){state.errorCode||=safe(error);state.status='failed';clearTimeout(deadlineTimer);
    if(pendingInput){const item=pendingInput;pendingInput=null;settleInput(item,'cancelledSerials');}}
  function armDeadline(){clearTimeout(deadlineTimer);deadlineTimer=setTimeout(()=>fail(new Error('canvas_bounded_completion_timeout')),2000);}
  function generatorSettings(){const s=generator.getSettings();return{width:s.width??null,height:s.height??null,frameRate:s.frameRate??null};}
  function admit(item) {
    if(closed||state.status==='failed'){settleInput(item,'cancelledSerials');return;}
    try {
      need(state.result.bounded.primed&&!active,'canvas_bounded_admission_overlap');
      const input={serial:item.metadata.serial,slot:item.metadata.slot,sourceTimestampUs:item.metadata.timestamp,receivedAtMs:item.receivedAtMs,drawAtMs:now()};
      active={serial:input.serial,input};state.result.bounded.maxCanvasAdmissions=Math.max(state.result.bounded.maxCanvasAdmissions,1);
      inputs.set(input.serial,input);state.result.inputs.push(input);armDeadline();
      track.requestFrame();const started=now();context.drawImage(item.frame,0,0,width,height);
      input.drawWallMs=now()-started;input.drawReturnedAtMs=now();state.status='running';
    }catch(error){fail(error);}finally{settleInput(item);}
  }
  function pump(){
    if(closed||state.status==='failed'||active||!pendingInput||admissionScheduled)return;
    // A writer completion may run in the microtask checkpoint of a Canvas task
    // observer. Start the next draw in a new task, never inside that checkpoint.
    // This message spends an existing credit; it creates no timer/frame credit.
    admissionScheduled=true;state.result.bounded.pendingAdmissionTask=true;
    state.result.bounded.maxPendingAdmissionTasks=1;state.result.bounded.admissionTaskPosts++;
    admissionChannel.port2.postMessage(0);
  }
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
      let copying=false,credit=false,sourceOutputClosed=false,writerFrame=null;
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
        need(Number.isSafeInteger(frame.timestamp)&&frame.timestamp>=0,'canvas_bounded_timestamp_invalid');
        need(lastTimestamp===null||frame.timestamp>=lastTimestamp,'canvas_bounded_timestamp_regressed');
        const duplicate=lastTimestamp!==null&&frame.timestamp===lastTimestamp;
        if(!state.result.bounded.primed){
          need(active?.prime&&serial===0&&state.result.warmupOutputs===0,'canvas_bounded_prime_invalid');
          need(info.colorSpace.fullRange===false&&((format==='NV12'&&info.colorSpace.matrix==='bt709')||
            (format==='I420'&&info.colorSpace.matrix==='smpte170m')),'canvas_output_color_contract_unsupported');
          for(const [x,y]of [[0,0],[width-2,0],[0,height-2],[width-2,height-2]]){
            need(Math.abs(data[layout[0].offset+y*layout[0].stride+x]-16)<=1,'canvas_initial_blank_pixels_invalid');
            const u=format==='NV12'?layout[1].offset+y/2*layout[1].stride+x:layout[1].offset+y/2*layout[1].stride+x/2;
            const v=format==='NV12'?u+1:layout[2].offset+y/2*layout[2].stride+x/2;
            need(Math.abs(data[u]-128)<=1&&Math.abs(data[v]-128)<=1,'canvas_initial_blank_pixels_invalid');
          }
          state.result.warmupOutputs++;state.result.bounded.primed=true;state.result.bounded.primeOutputTimestampUs=frame.timestamp;
          state.result.bounded.primeReceivedAtMs=receivedAtMs;lastTimestamp=frame.timestamp;active=null;clearTimeout(deadlineTimer);state.status='ready';continue;
        }
        if(serial===0){need(duplicate&&lastSerial===0,'canvas_unexpected_blank_output');state.result.duplicateOutputs++;continue;}
        need(inputs.has(serial)&&serial<=frames,'canvas_unknown_pixel_sequence');
        const colorKey=JSON.stringify(info.colorSpace);
        if(!state.result.outputFormats.includes(format))state.result.outputFormats.push(format);
        if(!state.result.outputColorSpaces.some(c=>JSON.stringify(c)===colorKey))state.result.outputColorSpaces.push(info.colorSpace);
        state.result.firstOutputMetadata??=info;
        const check=validate(data,layout,format,serial,info.colorSpace);
        if(!check.passed)state.result.failedOutput={serial,metadata:info,pixels:check};
        need(check.passed,'canvas_output_pixels_mismatch');
        if(duplicate){need(serial===lastSerial,'canvas_bounded_duplicate_pixels_changed');state.result.duplicateOutputs++;continue;}
        need(active&&!active.prime,'canvas_bounded_output_without_admission');
        need(serial===active.serial,'canvas_bounded_output_admission_mismatch');
        need(serial>=lastSerial,'canvas_output_sequence_regressed');lastSerial=serial;
        const input=inputs.get(serial);
        const sample={serial,receivedAtMs,settledAtMs,outputTimestampUs:frame.timestamp,
          frameAgeMs:receivedAtMs-input.drawAtMs,sourceToCopyCompleteAgeMs:settledAtMs-input.drawAtMs,
          copyCallWallMs:callReturnedAtMs-callAtMs,copyPromiseWallMs:settledAtMs-callAtMs,
          copyPostCallWallMs:settledAtMs-callReturnedAtMs,bytes,layout:layout.map(p=>({offset:p.offset,stride:p.stride})),pixels:check};
        need(!outputs.has(serial),'canvas_bounded_new_timestamp_for_old_pixels');
        if(closed||state.status==='failed')continue;
        if(sinkMode!=='none'){
          writerFrame=frame;
          if(sinkMode==='cpu'){
            const constructorStartedAtMs=now(),ownedBuffer=buffer;
            writerFrame=new VideoFrame(ownedBuffer,{format,codedWidth:width,codedHeight:height,
              displayWidth:width,displayHeight:height,timestamp:sample.outputTimestampUs,layout,colorSpace:info.colorSpace,transfer:[ownedBuffer]});
            need(ownedBuffer.byteLength===0,'canvas_cpu_frame_transfer_required');buffer=null;
            state.result.bounded.cpuFramesConstructed++;state.result.bounded.copyBuffersTransferred++;
            state.result.bounded.constructorSamples.push({serial,wallMs:now()-constructorStartedAtMs,transferred:true});
          }else if(sinkMode==='timestamp'){
            const constructorStartedAtMs=now();writerFrame=new VideoFrame(frame,{timestamp:input.sourceTimestampUs});
            state.result.bounded.constructorSamples.push({serial,wallMs:now()-constructorStartedAtMs,transferred:false});
          }
          if(writerFrame!==frame){frame.close();sourceOutputClosed=true;state.result.bounded.sourceOutputsClosedBeforeWrite++;}
          const writeStartedAtMs=now(),writerFrameTimestampUs=writerFrame.timestamp;
          writes++;state.result.bounded.maxWrites=Math.max(state.result.bounded.maxWrites,writes);
          let writeCalledAtMs,writeSettledAtMs;
          try{await writer.ready;writeCalledAtMs=now();await writer.write(writerFrame);writeSettledAtMs=now();}finally{writes--;}
          state.result.bounded.writes.push({serial,writerFrameTimestampUs,writeStartedAtMs,writeCalledAtMs,writeSettledAtMs,
            readyWallMs:writeCalledAtMs-writeStartedAtMs,writeWallMs:writeSettledAtMs-writeCalledAtMs,totalWallMs:writeSettledAtMs-writeStartedAtMs});
          state.result.bounded.writtenSerials.push(serial);state.result.bounded.generatorSettings=generatorSettings();
        }
        state.result.bounded.completedSerials.push(serial);
        outputs.add(serial);state.result.outputs.push(sample);lastTimestamp=sample.outputTimestampUs;
        if(!closed&&state.status!=='failed'){state.result.bounded.creditsGranted++;active=null;clearTimeout(deadlineTimer);credit=true;}
        state.result.lastOutputAtMs=settledAtMs;
      } catch(error){fail(error);throw error;} finally {
        // Never erase memory, close the output frame, or return before the real
        // copy settles. There is no timeout race around copyTo().
        if(!copying){if(buffer?.byteLength)new Uint8Array(buffer).fill(0);if(!sourceOutputClosed)frame.close();
          if(writerFrame&&writerFrame!==frame)writerFrame.close();}
        if(credit)pump();
      }
    }
  }
  function inputFrame(frame,metadata) {
    return new Promise(resolve=>{
      callbacks++;state.result.maxInputCallbacks=Math.max(state.result.maxInputCallbacks,callbacks);
      const item={frame,metadata,resolve,receivedAtMs:now(),settled:false};
      try {
      need(!closed&&state.status!=='failed'&&callbacks<=poolSize,'canvas_input_callback_invalid');
      need(metadata?.requestId===requestId&&metadata.width===width&&metadata.height===height&&
        Number.isInteger(metadata.serial)&&metadata.serial>0&&metadata.serial<=frames&&!state.result.bounded.receipts.some(r=>r.serial===metadata.serial)&&
        Number.isInteger(metadata.slot)&&metadata.slot>=0&&metadata.slot<poolSize,'canvas_input_metadata_invalid');
      const info=frameInfo(frame),color=info.colorSpace;
      need(info.format==='BGRA'&&info.codedWidth===width&&info.codedHeight===height&&frame.timestamp===metadata.timestamp&&
        color.primaries==='bt709'&&color.transfer==='iec61966-2-1'&&color.matrix==='rgb'&&color.fullRange===true,'canvas_input_color_or_format_mismatch');
      need(state.result.bounded.primed,'canvas_bounded_input_before_prime');state.result.inputMetadata??=info;
      state.result.bounded.receipts.push({serial:metadata.serial,receivedAtMs:item.receivedAtMs});
      if(!active&&!admissionScheduled)admit(item);else{
        if(pendingInput)settleInput(pendingInput,'supersededSerials');pendingInput=item;
        state.result.bounded.maxPendingInputs=Math.max(state.result.bounded.maxPendingInputs,1);
      }
      }catch(error){fail(error);settleInput(item);}
    });
  }
  window.__coveCanvasRouteCleanup=async()=>{
    closed=true;clearTimeout(deadlineTimer);unsubscribe?.();unsubscribe=null;
    admissionChannel?.port1.close();admissionChannel?.port2.close();admissionChannel=null;
    admissionScheduled=false;state.result.bounded.pendingAdmissionTask=false;
    if(pendingInput){const item=pendingInput;pendingInput=null;settleInput(item,'cancelledSerials');}track?.stop();
    try{await reader?.cancel();}catch{}
    await reading;
    if(writer){try{await writer.close();writerClosed=true;}catch(error){fail(error);}try{writer.releaseLock();}catch{}}
    if(generator){state.result.bounded.generatorSettings=generatorSettings();generator.stop();}writer=null;generator=null;
    try{reader?.releaseLock();}catch{}
    reader=null;track=null;
    canvas?.remove();if(state.result.canvasConnection)state.result.canvasConnection.isConnectedAfterCleanup=canvas?.isConnected===true;
    canvas=null;context=null;if(buffer?.byteLength)new Uint8Array(buffer).fill(0);buffer=null;
    state.result.memoryAfter=memory();
    return{callbacks,pendingCopies:pending,pendingWrites:writes,pendingInputFrames:pendingInput?1:0,
      pendingCanvasAdmissions:active?1:0,pendingAdmissionTasks:admissionScheduled?1:0,admissionPortsClosed:true,
      writerClosed,readerStopped:true,canvasRemoved:true,copyBufferReleased:true,status:state.status,errorCode:state.errorCode};
  };
  const supported=!!(window.coveNativeScreen?.supported&&typeof window.coveNativeScreen.onFrame==='function'&&
    typeof MediaStreamTrackProcessor==='function'&&(sinkMode==='none'||typeof MediaStreamTrackGenerator==='function')&&typeof MessageChannel==='function'&&typeof VideoFrame==='function');
  try {
    need(supported,'canvas_renderer_api_unavailable');need(['none','direct','cpu','timestamp'].includes(sinkMode),'canvas_bounded_sink_invalid');
    need(['attached','detached'].includes(canvasPlacement),'canvas_bounded_placement_invalid');need(crossOriginIsolated===false,'canvas_non_coi_page_required');
    state.result.memoryBefore=memory();canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    if(canvasPlacement==='attached')document.body.append(canvas);
    context=canvas.getContext('2d',{alpha:false,willReadFrequently:false});need(context,'canvas_context_unavailable');
    const attributes=context.getContextAttributes();need(attributes.alpha===false&&attributes.willReadFrequently===false,'canvas_context_attributes_mismatch');
    state.result.contextAttributes={alpha:attributes.alpha,willReadFrequently:attributes.willReadFrequently,colorSpace:attributes.colorSpace??null};
    state.result.canvasConnection={placement:canvasPlacement,isConnected:canvas.isConnected===true,width:canvas.width,height:canvas.height,
      displayStyle:canvas.style?.display??null,visibilityStyle:canvas.style?.visibility??null,opacityStyle:canvas.style?.opacity??null};
    const stream=canvas.captureStream(0);track=stream.getVideoTracks()[0];need(track&&typeof track.requestFrame==='function','canvas_request_frame_unavailable');
    track.contentHint='detail';const processor=new MediaStreamTrackProcessor({track,maxBufferSize:1});reader=processor.readable.getReader();
    if(sinkMode!=='none'){generator=new MediaStreamTrackGenerator({kind:'video'});generator.contentHint='detail';writer=generator.writable.getWriter();}
    admissionChannel=new MessageChannel();admissionChannel.port1.onmessage=()=>{
      admissionScheduled=false;state.result.bounded.pendingAdmissionTask=false;
      if(closed||state.status==='failed'||active||!pendingInput)return;
      const item=pendingInput;pendingInput=null;admit(item);
    };
    reading=readOutputs().catch(error=>{if(!closed)fail(error);});
    unsubscribe=window.coveNativeScreen.onFrame(requestId,inputFrame);
    // Context initialization, Processor attachment, auto-request and explicit
    // prime occur in one synchronous task, before any native source is started.
    // The bool request flag coalesces these requests. No Canvas track escapes.
    active={prime:true};state.result.bounded.maxCanvasAdmissions=1;armDeadline();
    track.requestFrame();context.fillStyle='#000000';context.fillRect(0,0,width,height);state.status='priming';
  } catch(error){fail(error);}
  return{supported,crossOriginIsolated,nodeType:typeof require,sharedArrayBufferType:typeof SharedArrayBuffer,
    processorAvailable:typeof MediaStreamTrackProcessor==='function',contextAttributes:state.result.contextAttributes,status:state.status,errorCode:state.errorCode};
};
