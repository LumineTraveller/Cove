import { withScreenEncodingPlan, type ScreenEncodingPlan } from './screenCapture';

type ScreenEncodingSender = Pick<RTCRtpSender, 'getParameters' | 'setParameters'>;

export type ScreenEncodingParameterUpdate =
  | { readonly status: 'unavailable' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'submitted'; readonly completion: Promise<void> };

// An earlier asynchronous submission can still overwrite a matching snapshot.
// Count all unsettled submissions for each sender, without retaining senders.
const inFlightUpdates = new WeakMap<ScreenEncodingSender, number>();

function releaseUpdate(sender: ScreenEncodingSender): void {
  const remaining = (inFlightUpdates.get(sender) ?? 1) - 1;
  if (remaining === 0) inFlightUpdates.delete(sender);
  else inFlightUpdates.set(sender, remaining);
}

function controlledParametersMatch(
  current: RTCRtpSendParameters,
  planned: RTCRtpSendParameters,
): boolean {
  // With no encodings there is no actual encoding against which to verify the plan.
  if (!current.encodings.length || current.degradationPreference !== planned.degradationPreference)
    return false;

  return current.encodings.every((encoding, index) => {
    const target = planned.encodings[index];
    return (
      encoding.maxBitrate === target.maxBitrate &&
      encoding.maxFramerate === target.maxFramerate &&
      encoding.scaleResolutionDownBy === target.scaleResolutionDownBy
    );
  });
}

/** Submit the existing plan unless the sender already has it and no update is pending. */
export function updateScreenEncodingParametersIfNeeded(
  sender: ScreenEncodingSender,
  plan: ScreenEncodingPlan,
): ScreenEncodingParameterUpdate {
  const current = sender.getParameters();
  if (!current) return { status: 'unavailable' };
  const planned = withScreenEncodingPlan(current, plan);
  if (!inFlightUpdates.has(sender) && controlledParametersMatch(current, planned)) {
    return { status: 'unchanged' };
  }

  // Register before calling the sender so even a reentrant call sees this update.
  inFlightUpdates.set(sender, (inFlightUpdates.get(sender) ?? 0) + 1);
  try {
    const completion = sender.setParameters(planned).finally(() => releaseUpdate(sender));
    return { status: 'submitted', completion };
  } catch (error) {
    releaseUpdate(sender);
    throw error;
  }
}
