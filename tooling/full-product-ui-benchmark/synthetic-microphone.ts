/** Restrict the already-installed fixture oscillator; create no extra graph. */
export function guardFixtureMicrophone(mode: string) {
  if(!['muted','synthetic-varying'].includes(mode))throw Error('Invalid synthetic microphone mode');
  const fixtureSyntheticUserMedia=navigator.mediaDevices.getUserMedia;
  let released=false,requests=0,rejectedRequests=0;
  const snapshot=()=>({provider:'screen-performance-fixture' as const,mode,
    gain:mode==='muted'?0.03:null,gainMin:mode==='muted'?0.03:0.005,gainMax:mode==='muted'?0.03:0.05,curveSeconds:mode==='muted'?0:120,
    physicalMicrophone:false,humanVoice:false,speakerOutput:false,requests,rejectedRequests,released});
  const getUserMedia:typeof navigator.mediaDevices.getUserMedia=async constraints=>{
    requests++;
    if(released||!constraints?.audio||Boolean(constraints.video)){
      rejectedRequests++;throw new DOMException('Only fixture synthetic audio is available','NotSupportedError');
    }
    return fixtureSyntheticUserMedia.call(navigator.mediaDevices,constraints);
  };
  navigator.mediaDevices.getUserMedia=getUserMedia;
  return {snapshot,release(){
    released=true;
    // Restore the exact fixture function so its existing cleanup can restore
    // the earlier observer and dispose its own testAudio nodes/contexts.
    if(navigator.mediaDevices.getUserMedia===getUserMedia)navigator.mediaDevices.getUserMedia=fixtureSyntheticUserMedia;
  }};
}
