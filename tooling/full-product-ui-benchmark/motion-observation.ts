import {observeNativeFrameStability} from '../../apps/desktop/src/features/media/screen/nativeScreenCapture';
import {readFramePresentation} from '../../apps/desktop/src/features/media/diagnostics/framePresentation';

/** One numeric native observer; reads the existing product video binding only. */
export function createMotionObservation(enabled:boolean){
  let track:MediaStreamTrack|null=null,producer:string|null=null;
  let observer:ReturnType<typeof observeNativeFrameStability>=null;
  let changed=false,disposed=false;
  return {
    snapshot(rtc:any){
      if(!enabled)return null;
      const current=rtc?.localScreen?.getVideoTracks()[0] as MediaStreamTrack|undefined;
      if(!observer&&current?.readyState==='live'&&!disposed){
        const next=observeNativeFrameStability(current);
        if(next){track=current;producer=rtc.localScreenProducerId;observer=next;}
      }
      if(track&&(current!==track||rtc?.localScreenProducerId!==producer))changed=true;
      const now=performance.now();
      return {sampledAt:performance.timeOrigin+now,disposed,
        sameTrack:!!track&&!changed&&current===track,sameProducer:!!producer&&!changed&&rtc?.localScreenProducerId===producer,
        nativeDelivery:observer?.snapshot(now)??null,
        presentation:track&&current===track?readFramePresentation(track,now):null,
        nativeDeliveryStability:rtc?.stats?.nativeDeliveryStability??null,
        presentationStability:rtc?.stats?.presentationStability??null,
        meaning:'Exact-time fixture native observer and the existing product presentation reader; actual product collector snapshots are also retained under their original names. No new presentation binding, frame copy, timestamp rewrite or history reset.'};
    },
    dispose(){if(disposed)return;disposed=true;observer?.dispose();observer=null;},
    resources(){return {motionNativeObservers:observer?1:0,motionObservationDisposed:disposed};},
  };
}
