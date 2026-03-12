import { Component, OnDestroy, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

const API_BASE = 'https://qtr7viace9.execute-api.us-east-1.amazonaws.com/dev';

// ── Shared types ────────────────────────────────────────────────────────────
type Step = 'form' | 'uploading' | 'processing' | 'done' | 'error';
type FcStep = 'form' | 'uploading' | 'processing' | 'done' | 'error';

interface InitResponse {
  fundId: string;
  uploadUrl: string;
  objectKey: string;
  documentType: string;
  expiresIn: number;
}

interface FundRecord {
  fundId: string;
  status: string;
  documentType?: string;
  fundName?: string;
  resultPath?: string;
  errorReason?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

// ── FormCheck types ──────────────────────────────────────────────────────────
interface FcInitResponse {
  jobId: string;
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
}

interface FcIncompleteItem {
  label: string;
  selected: boolean | null;
  value: string | null;
}

interface FcSection {
  title: string;
  type: string;
  issue?: string;
  page?: number;
  items: FcIncompleteItem[];
}

interface FcUncertainItem {
  title: string;
  reason: string;
  page?: number;
  items: FcIncompleteItem[];
}

interface FcResult {
  valid: boolean;
  incompleteSections: FcSection[];
  uncertainItems?: FcUncertainItem[];
  summary: string;
}

interface FcStatusResponse {
  jobId: string;
  status: string;
  fileName?: string;
  createdAt?: string;
  completedAt?: string;
  errorReason?: string;
  result?: FcResult;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnDestroy {
  // ── Tab ────────────────────────────────────────────────────────────────────
  activeTab: 'upload' | 'formcheck' = 'upload';

  // ── Upload tab ─────────────────────────────────────────────────────────────
  @ViewChild('logBox') logBox!: ElementRef<HTMLDivElement>;

  documentType = 'icmemo';
  fundName = '';
  rawFundId = '';
  fileName = '';
  selectedFile: File | null = null;

  step: Step = 'form';
  uploadProgress = 0;
  returnedFundId = '';
  currentStatus = '';
  pollCount = 0;
  fundRecord: FundRecord | null = null;
  errorMessage = '';
  logs: string[] = [];

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  get isIMA(): boolean { return this.documentType === 'ima'; }

  get canSubmit(): boolean {
    return (
      !!this.fundName.trim() &&
      !!this.selectedFile &&
      (!this.isIMA || !!this.rawFundId.trim())
    );
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.[0]) {
      this.selectedFile = input.files[0];
      this.fileName = this.selectedFile.name;
    }
  }

  async startUpload(): Promise<void> {
    this.step = 'uploading';
    this.uploadProgress = 0;
    this.logs = [];
    this.errorMessage = '';
    this.fundRecord = null;

    try {
      this.log('POST /funds/upload/init ...');
      const qs = new URLSearchParams({ documentType: this.documentType, fundName: this.fundName.trim(), fileName: this.fileName });
      if (this.isIMA && this.rawFundId.trim()) qs.set('fundId', this.rawFundId.trim());

      const initResp = await fetch(`${API_BASE}/funds/upload/init?${qs}`, { method: 'POST' });
      const initData = await initResp.json() as InitResponse & { error?: string };
      if (!initResp.ok) throw new Error(initData.error ?? `Init failed (${initResp.status})`);

      this.returnedFundId = initData.fundId;
      this.log(`Fund ID : ${initData.fundId}`);
      this.log(`S3 key  : ${initData.objectKey}`);
      this.log(`URL exp : ${initData.expiresIn}s`);
      this.log('Uploading PDF to S3 ...');

      const headers: Record<string, string> = {
        'Content-Type': 'application/pdf',
        'x-amz-meta-fund-name': this.fundName.trim()
      };
      if (this.isIMA) headers['x-amz-meta-fund-id'] = initData.fundId;

      await this.xhrUpload(initData.uploadUrl, this.selectedFile!, headers);
      this.log('S3 upload complete.');
      this.step = 'processing';
      this.currentStatus = 'UPLOADING';
      this.log('Polling for processing status ...');
      this.startPolling(initData.fundId);

    } catch (err: unknown) {
      this.step = 'error';
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.log(`ERROR: ${this.errorMessage}`);
    }
  }

  private xhrUpload(url: string, file: File, headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) this.uploadProgress = Math.round((e.loaded / e.total) * 100);
      };
      xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error(`S3 PUT ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
      xhr.onerror = () => reject(new Error('Network error during S3 upload'));
      xhr.send(file);
    });
  }

  private startPolling(fundId: string): void {
    const MAX = 72;
    this.pollCount = 0;
    this.pollTimer = setInterval(async () => {
      this.pollCount++;
      if (this.pollCount > MAX) {
        this.stopPolling();
        this.step = 'error';
        this.errorMessage = 'Timed out waiting for processing (6 min).';
        return;
      }
      try {
        const resp = await fetch(`${API_BASE}/funds/${encodeURIComponent(fundId)}`);
        if (!resp.ok) return;
        const data = await resp.json() as FundRecord;
        this.currentStatus = data.status;
        this.log(`Status: ${data.status}`);
        if (data.status === 'SUCCEEDED') {
          this.stopPolling(); this.fundRecord = data; this.step = 'done'; this.log('Done!');
        } else if (data.status === 'FAILED') {
          this.stopPolling(); this.step = 'error';
          this.errorMessage = data['errorReason'] as string ?? 'Processing failed.';
          this.log(`FAILED: ${this.errorMessage}`);
        }
      } catch { /* ignore transient poll errors */ }
    }, 5000);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private log(msg: string): void {
    this.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    setTimeout(() => {
      if (this.logBox?.nativeElement) {
        this.logBox.nativeElement.scrollTop = this.logBox.nativeElement.scrollHeight;
      }
    });
  }

  reset(): void {
    this.stopPolling();
    this.step = 'form';
    this.selectedFile = null;
    this.fileName = '';
    this.fundName = '';
    this.rawFundId = '';
    this.returnedFundId = '';
    this.currentStatus = '';
    this.fundRecord = null;
    this.errorMessage = '';
    this.logs = [];
    this.uploadProgress = 0;
    this.pollCount = 0;
  }

  resultKeys(record: FundRecord): string[] {
    return Object.keys(record).filter(k => !['fundId'].includes(k));
  }

  // ── FormCheck tab ──────────────────────────────────────────────────────────
  @ViewChild('fcLogBox') fcLogBox!: ElementRef<HTMLDivElement>;

  fcSelectedFile: File | null = null;
  fcFileName = '';

  fcStep: FcStep = 'form';
  fcUploadProgress = 0;
  fcJobId = '';
  fcCurrentStatus = '';
  fcPollCount = 0;
  fcResult: FcResult | null = null;
  fcDocumentName = '';
  fcErrorMessage = '';
  fcLogs: string[] = [];
  fcExpandedSections: Set<number> = new Set();

  private fcPollTimer: ReturnType<typeof setInterval> | null = null;

  get fcCanSubmit(): boolean { return !!this.fcSelectedFile; }

  onFcFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.[0]) {
      this.fcSelectedFile = input.files[0];
      this.fcFileName = this.fcSelectedFile.name;
    }
  }

  async startFormCheck(): Promise<void> {
    this.fcStep = 'uploading';
    this.fcUploadProgress = 0;
    this.fcLogs = [];
    this.fcErrorMessage = '';
    this.fcResult = null;
    this.fcExpandedSections = new Set();

    try {
      this.fcLog('POST /formcheck/init ...');
      const qs = new URLSearchParams({ fileName: this.fcFileName });
      const initResp = await fetch(`${API_BASE}/formcheck/init?${qs}`, { method: 'POST' });
      const initData = await initResp.json() as FcInitResponse & { error?: string };
      if (!initResp.ok) throw new Error(initData.error ?? `Init failed (${initResp.status})`);

      this.fcJobId = initData.jobId;
      this.fcLog(`Job ID  : ${initData.jobId}`);
      this.fcLog(`S3 key  : ${initData.objectKey}`);
      this.fcLog(`URL exp : ${initData.expiresIn}s`);
      this.fcLog('Uploading PDF to S3 ...');

      await this.fcXhrUpload(initData.uploadUrl, this.fcSelectedFile!);
      this.fcLog('S3 upload complete.');
      this.fcStep = 'processing';
      this.fcCurrentStatus = 'UPLOADING';
      this.fcLog('Polling for analysis status ...');
      this.startFcPolling(initData.jobId);

    } catch (err: unknown) {
      this.fcStep = 'error';
      this.fcErrorMessage = err instanceof Error ? err.message : String(err);
      this.fcLog(`ERROR: ${this.fcErrorMessage}`);
    }
  }

  private fcXhrUpload(url: string, file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/pdf');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) this.fcUploadProgress = Math.round((e.loaded / e.total) * 100);
      };
      xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error(`S3 PUT ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
      xhr.onerror = () => reject(new Error('Network error during S3 upload'));
      xhr.send(file);
    });
  }

  private startFcPolling(jobId: string): void {
    const MAX = 120; // 10 min at 5s intervals (Textract FORMS takes longer)
    this.fcPollCount = 0;
    this.fcPollTimer = setInterval(async () => {
      this.fcPollCount++;
      if (this.fcPollCount > MAX) {
        this.stopFcPolling();
        this.fcStep = 'error';
        this.fcErrorMessage = 'Timed out waiting for analysis (10 min).';
        return;
      }
      try {
        const resp = await fetch(`${API_BASE}/formcheck/${encodeURIComponent(jobId)}`);
        if (!resp.ok) return;
        const data = await resp.json() as FcStatusResponse;
        this.fcCurrentStatus = data.status;
        this.fcLog(`Status: ${data.status}`);
        if (data.status === 'SUCCEEDED') {
          this.stopFcPolling();
          this.fcResult = data.result ?? null;
          this.fcDocumentName = data.fileName ?? '';
          this.fcStep = 'done';
          this.fcLog('Analysis complete!');
          console.log('[FormCheck] Full result JSON:', JSON.stringify({ fileName: data.fileName, jobId: data.jobId, ...data.result }, null, 2));
        } else if (data.status === 'FAILED') {
          this.stopFcPolling();
          this.fcStep = 'error';
          this.fcErrorMessage = data.errorReason ?? 'Analysis failed.';
          this.fcLog(`FAILED: ${this.fcErrorMessage}`);
        }
      } catch { /* ignore transient poll errors */ }
    }, 5000);
  }

  private stopFcPolling(): void {
    if (this.fcPollTimer) { clearInterval(this.fcPollTimer); this.fcPollTimer = null; }
  }

  private fcLog(msg: string): void {
    this.fcLogs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    setTimeout(() => {
      if (this.fcLogBox?.nativeElement) {
        this.fcLogBox.nativeElement.scrollTop = this.fcLogBox.nativeElement.scrollHeight;
      }
    });
  }

  toggleSection(i: number): void {
    if (this.fcExpandedSections.has(i)) {
      this.fcExpandedSections.delete(i);
    } else {
      this.fcExpandedSections.add(i);
    }
  }

  resetFormCheck(): void {
    this.stopFcPolling();
    this.fcStep = 'form';
    this.fcSelectedFile = null;
    this.fcFileName = '';
    this.fcJobId = '';
    this.fcCurrentStatus = '';
    this.fcResult = null;
    this.fcErrorMessage = '';
    this.fcLogs = [];
    this.fcUploadProgress = 0;
    this.fcPollCount = 0;
    this.fcExpandedSections = new Set();
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.stopFcPolling();
  }
}
