export type FailureScope = 'operation' | 'media' | 'session' | 'server';
export interface DiagnosticEvent {
  component: string;
  operation: string;
  scope: FailureScope;
  code: string;
  timestamp: number;
  message: string;
}
export interface DiagnosticSink {
  write(event: DiagnosticEvent): void;
}
/** Structured metadata only: never serialize credentials or whole wire payloads. */
export function diagnosticError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
