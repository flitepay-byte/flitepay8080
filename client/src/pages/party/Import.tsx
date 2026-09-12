import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Upload, Download, CheckCircle2, AlertTriangle, Copy } from 'lucide-react';
import { api, ApiRequestError, API_BASE } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Metric, Money, EmptyState, cn } from '@/components/primitives';

interface RowIssue {
  rowNumber: number;
  field: string;
  message: string;
  rawValue?: string;
}

interface PreviewResult {
  batchId: string;
  batchCode: string;
  total: number;
  valid: number;
  invalid: number;
  duplicate: number;
  errors: RowIssue[];
  duplicates: RowIssue[];
  sample: Array<{
    rowNumber: number;
    customerName: string;
    identifier: string;
    amount: number;
    externalRef: string;
  }>;
}

interface ConfirmResult {
  batchCode: string;
  imported: number;
  failures: Array<{ externalRef: string; message: string }>;
}

const TEMPLATE = `customerName,identifier,amount,externalRef
Rahul Sharma,DEMO-UPI-001,10000,DEMO-REF-001
Priya Menon,DEMO-UPI-002,5000,DEMO-REF-002`;

/**
 * Two-step import: validate and preview first, create only on confirmation.
 * Nothing is written until the user has seen exactly what will happen.
 */
export function PartyImport() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<ConfirmResult | null>(null);

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('file', file as File);
      return api.upload<PreviewResult>('/party/imports/preview', form);
    },
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const confirm = useMutation({
    mutationFn: () => api.post<ConfirmResult>('/party/imports/confirm', { batchId: preview?.batchId }),
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
      setFile(null);
      toast.show('success', `${data.imported} task(s) created.`);
      void queryClient.invalidateQueries({ queryKey: ['party-tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['party-dashboard'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const copyTemplate = async (): Promise<void> => {
    await navigator.clipboard.writeText(TEMPLATE);
    toast.show('info', 'Template copied.');
  };

  const allIssues = preview ? [...preview.errors, ...preview.duplicates].sort((a, b) => a.rowNumber - b.rowNumber) : [];

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Party</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">Bulk import</h1>
        <p className="mt-1 text-xs text-ink-400">
          Upload a CSV to check it. Nothing is created until you confirm.
        </p>
      </div>

      <Panel
        title="Choose a file"
        action={
          <button type="button" onClick={copyTemplate} className="btn-ghost px-2 py-1 text-2xs">
            <Copy className="h-3 w-3" /> Copy template
          </button>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <label
            className={cn(
              'flex flex-1 cursor-pointer items-center gap-2.5 rounded-md border border-dashed px-3 py-2.5 transition-colors',
              file ? 'border-signal-green/50 bg-signal-green/5' : 'border-ink-600 hover:border-ink-500',
            )}
          >
            <Upload className="h-4 w-4 shrink-0 text-ink-400" />
            <span className="min-w-0 flex-1 truncate text-xs text-ink-200">
              {file ? file.name : 'Choose a .csv file'}
            </span>
            <input
              type="file"
              accept=".csv"
              className="sr-only"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setResult(null); }}
            />
          </label>
          <button type="button" onClick={() => upload.mutate()} disabled={!file || upload.isPending} className="btn-primary">
            {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Check file'}
          </button>
        </div>
        <p className="mt-2 font-mono text-2xs text-ink-500">customerName,identifier,amount,externalRef</p>
      </Panel>

      {preview && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Rows read" value={preview.total} />
            <Metric label="Ready" value={preview.valid} tone="green" />
            <Metric label="Has errors" value={preview.invalid} tone={preview.invalid > 0 ? 'red' : 'default'} />
            <Metric label="Duplicates" value={preview.duplicate} tone={preview.duplicate > 0 ? 'amber' : 'default'} />
          </div>

          {preview.valid > 0 && (
            <Panel title="Ready to import" eyebrow={`showing ${preview.sample.length} of ${preview.valid}`} bodyClassName="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-800 text-left">
                      <th className="px-4 py-2.5 eyebrow font-normal">Row</th>
                      <th className="px-4 py-2.5 eyebrow font-normal">Beneficiary</th>
                      <th className="px-4 py-2.5 eyebrow font-normal">Reference</th>
                      <th className="px-4 py-2.5 eyebrow font-normal text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-800">
                    {preview.sample.map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="px-4 py-2.5 font-mono tnum text-2xs text-ink-500">{row.rowNumber}</td>
                        <td className="px-4 py-2.5 text-xs text-ink-100">{row.customerName}</td>
                        <td className="px-4 py-2.5 font-mono text-2xs text-ink-300">{row.externalRef}</td>
                        <td className="px-4 py-2.5 text-right"><Money amount={row.amount} className="text-xs text-ink-50" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {allIssues.length > 0 && (
            <Panel
              title="Rows that will be skipped"
              eyebrow={`${allIssues.length} issue(s)`}
              action={
                <a
                  href={`${API_BASE}/party/imports/${preview.batchId}/errors.csv`}
                  className="btn-ghost px-2 py-1 text-2xs"
                  download
                >
                  <Download className="h-3 w-3" /> Download report
                </a>
              }
              bodyClassName="p-0 max-h-64 overflow-y-auto"
            >
              <ul className="divide-y divide-ink-800">
                {allIssues.slice(0, 50).map((issue, index) => (
                  <li key={`${issue.rowNumber}-${issue.field}-${index}`} className="flex items-start gap-3 px-4 py-2.5">
                    <span className="mt-0.5 w-10 shrink-0 font-mono tnum text-2xs text-ink-500">
                      row {issue.rowNumber}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-ink-100">{issue.message}</p>
                      <p className="mt-0.5 font-mono text-2xs text-ink-500">
                        {issue.field}
                        {issue.rawValue && <span> — “{issue.rawValue}”</span>}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-ink-700 bg-ink-900 px-4 py-3.5">
            <p className="text-xs text-ink-300">
              {preview.valid > 0
                ? `${preview.valid} task(s) will be created. The rest are skipped.`
                : 'No rows can be imported. Fix the issues and upload again.'}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => { setPreview(null); setFile(null); }} className="btn-secondary">
                Discard
              </button>
              <button
                type="button"
                onClick={() => confirm.mutate()}
                disabled={preview.valid === 0 || confirm.isPending}
                className="btn-primary"
              >
                {confirm.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : `Import ${preview.valid} task(s)`}
              </button>
            </div>
          </div>
        </>
      )}

      {result && (
        <Panel>
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-signal-green" />
            <div className="min-w-0 flex-1">
              <p className="font-display text-sm font-semibold text-ink-50">
                Imported {result.imported} task(s)
              </p>
              <p className="mt-0.5 font-mono text-2xs text-ink-400">{result.batchCode}</p>
              {result.failures.length > 0 && (
                <div className="mt-3 rounded-md border border-signal-amber/40 bg-signal-amber/10 px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-xs text-signal-amber">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {result.failures.length} row(s) could not be created
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {result.failures.slice(0, 5).map((failure) => (
                      <li key={failure.externalRef} className="font-mono text-2xs text-ink-300">
                        {failure.externalRef}: {failure.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </Panel>
      )}

      {!preview && !result && !file && (
        <Panel><EmptyState title="No file chosen" hint="Pick a CSV above to check it before importing." /></Panel>
      )}
    </div>
  );
}
