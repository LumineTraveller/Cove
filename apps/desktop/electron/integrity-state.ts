// Serializable contract shared by Electron and the settings renderer.
export type InstallationIntegrityStatus =
  | 'disabled' | 'idle' | 'checking' | 'healthy' | 'damaged' | 'unavailable'
  | 'downloading' | 'downloaded' | 'confirming' | 'launching' | 'error';

export interface InstallationIntegrityIssue {
  path: string;
  kind: 'missing' | 'modified' | 'unreadable' | 'unsafe';
}

export interface InstallationIntegrityState {
  status: InstallationIntegrityStatus;
  version: string;
  platform: string;
  arch: string;
  message?: string;
  errorCode?: string;
  checkedAt?: number;
  checkedFiles?: number;
  totalFiles?: number;
  issueCount?: number;
  /** Bounded details; issueCount is the full count. Paths are relative only. */
  issues?: InstallationIntegrityIssue[];
  repairAvailable?: boolean;
  progress?: { transferred: number; total: number; percent: number };
}

export interface InstallationIntegrityApi {
  getState(): Promise<InstallationIntegrityState>;
  checkNow(): Promise<InstallationIntegrityState>;
  downloadRepair(): Promise<InstallationIntegrityState>;
  cancel(): Promise<InstallationIntegrityState>;
  /** Main process always presents a native confirmation before any launch/quit. */
  launchRepair(): Promise<boolean>;
  openRelease(): Promise<boolean>;
  onState(listener: (state: InstallationIntegrityState) => void): () => void;
}

export function isInstallationIntegrityBusy(status: InstallationIntegrityStatus): boolean {
  return ['checking', 'downloading', 'confirming', 'launching'].includes(status);
}
