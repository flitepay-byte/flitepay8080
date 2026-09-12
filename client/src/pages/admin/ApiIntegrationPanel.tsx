import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  KeyRound, Copy, Check, AlertTriangle, Plug, FileDown, Trash2, Pencil, CircleDot,
} from 'lucide-react';
import { api, API_BASE, csrfToken, type ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, EmptyState, TableSkeleton } from '@/components/primitives';
import { when } from '@/lib/datetime';

interface AdminApiKey {
  keyId: string;
  label: string;
  status: 'ACTIVE' | 'REVOKED';
  callbackUrl: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface IssuedKey {
  keyId: string;
  secret: string;
  label: string;
  callbackUrl: string | null;
}

/**
 * API integration, for an administrator who is not a developer.
 *
 * The whole panel is arranged around that. It is a numbered sequence rather than
 * a set of controls, because somebody onboarding their first party does not know
 * what a callback URL is for or in which order these things have to happen — and
 * the cost of guessing is a party that cannot go live and an administrator who
 * cannot say why.
 *
 * Everything technical is pushed into the generated document. The administrator
 * never has to explain signing to anybody; they create a key, download the PDF,
 * and send it.
 *
 * The secret appears once, in a panel that says so in the strongest terms the
 * page has. There is no endpoint that could show it again.
 */
export function ApiIntegrationPanel({ partyId }: { partyId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [label, setLabel] = useState('Production');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [copied, setCopied] = useState<'keyId' | 'secret' | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');

  const keys = useQuery<{ keys: AdminApiKey[] }>({
    queryKey: ['admin-party-api-keys', partyId],
    queryFn: () => api.get<{ keys: AdminApiKey[] }>(`/admin/parties/${partyId}/api-keys`),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin-party-api-keys', partyId] });
  };

  const createKey = useMutation({
    mutationFn: () =>
      api.post<IssuedKey>(`/admin/parties/${partyId}/api-keys`, {
        label: label.trim(),
        ...(callbackUrl.trim() ? { callbackUrl: callbackUrl.trim() } : {}),
      }),
    onSuccess: (data) => {
      setIssued(data);
      setCallbackUrl('');
      invalidate();
      toast.show('success', 'Key created — copy the secret now');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) => api.del(`/admin/parties/${partyId}/api-keys/${keyId}`),
    onSuccess: () => {
      invalidate();
      toast.show('success', 'Key revoked — calls with it will be refused');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const saveCallback = useMutation({
    mutationFn: (vars: { keyId: string; url: string }) =>
      api.patch(`/admin/parties/${partyId}/api-keys/${vars.keyId}/callback-url`, {
        callbackUrl: vars.url.trim() || null,
      }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
      toast.show('success', 'Callback URL saved');
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const copy = (value: string, which: 'keyId' | 'secret'): void => {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(which);
        setTimeout(() => setCopied(null), 2000);
      },
      () => toast.show('error', 'Could not copy — select the text and copy it by hand.'),
    );
  };

  /**
   * The PDF is fetched rather than linked, because the secret has to travel in
   * the body: a URL would put a live credential into browser history and every
   * access log between here and the server.
   */
  const downloadPdf = async (keyId: string, secret?: string): Promise<void> => {
    try {
      const res = await fetch(`${API_BASE}/admin/parties/${partyId}/api-keys/${keyId}/integration.pdf`, {
        method: 'POST',
        credentials: 'include',
        // The CSRF header every other write in the app sends. A raw fetch does
        // not get it for free, which is what made this download fail.
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken() ?? '',
        },
        body: JSON.stringify(secret ? { secret } : {}),
      });
      if (!res.ok) {
        // Say what actually happened rather than "could not download" — a 403
        // and a missing key are different problems with different fixes.
        const detail = await res.text().catch(() => '');
        throw new Error(detail || `Request failed with ${res.status}`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `otdms-integration-${keyId}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.show('success', 'Downloaded — send this to the party’s developer');
    } catch (err) {
      toast.show('error', err instanceof Error ? err.message : 'Could not download the document.');
    }
  };

  const rows = keys.data?.keys ?? [];
  const hasActive = rows.some((k) => k.status === 'ACTIVE');
  const everUsed = rows.some((k) => k.lastUsedAt);

  return (
    <div className="space-y-3">
      {/* ------------------------------------------------- the sequence -- */}
      <Panel
        title="API integration"
        eyebrow="how this party connects their own website to us"
        action={<Plug className="h-4 w-4 text-ink-400" />}
      >
        <ol className="space-y-2">
          <Step n={1} done={rows.length > 0} label="Create an API key" hint="Below. Name it after where it will be used — Production, or Staging." />
          <Step n={2} done={Boolean(issued)} label="Copy the credentials" hint="The secret is shown once and cannot be recovered afterwards." />
          <Step n={3} done={false} label="Send the party their API details" hint="Download the PDF and email it to their developer. It explains everything they need." />
          <Step n={4} done={rows.some((k) => k.callbackUrl)} label="Set the callback URL" hint="Where we send updates when a payment settles. Ask the party for it." />
          <Step n={5} done={everUsed} label="Check the integration is live" hint="“Last used” fills in below the first time their server calls us." />
        </ol>
      </Panel>

      {/* ------------------------------------------- the secret, once ---- */}
      {issued && (
        <Panel
          title="Copy these now"
          eyebrow="the secret is shown once and cannot be shown again"
          action={<KeyRound className="h-4 w-4 text-signal-amber" />}
        >
          <div className="mb-3 flex items-start gap-2 rounded-md border border-signal-amber/40 bg-signal-amber/10 px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-amber" />
            <p className="text-2xs leading-relaxed text-ink-100">
              Copy the secret into the document you send, or download the PDF below while it is on screen.
              We cannot show it again — if it is lost, create a new key and revoke this one.
            </p>
          </div>

          <CopyRow label="Key ID" value={issued.keyId} copied={copied === 'keyId'} onCopy={() => copy(issued.keyId, 'keyId')} />
          <CopyRow label="Secret" value={issued.secret} copied={copied === 'secret'} onCopy={() => copy(issued.secret, 'secret')} />

          <button
            type="button"
            className="btn-primary mt-3 w-full gap-1.5 py-2 text-xs"
            onClick={() => void downloadPdf(issued.keyId, issued.secret)}
          >
            <FileDown className="h-3.5 w-3.5" />
            Download API details (PDF, includes the secret)
          </button>
          <button type="button" className="btn-ghost mt-1.5 w-full py-1.5 text-2xs" onClick={() => setIssued(null)}>
            I have saved these — hide them
          </button>
        </Panel>
      )}

      {/* ------------------------------------------------ create a key --- */}
      <Panel title="Create an API key" eyebrow={hasActive ? 'this party already has one' : 'needed before they can integrate'}>
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="key-label" className="field-label">Name</label>
            <input id="key-label" className="field-input text-xs" value={label} onChange={(e) => setLabel(e.target.value)} />
            <p className="mt-1 text-2xs text-ink-500">So you can tell keys apart later.</p>
          </div>
          <div>
            <label htmlFor="key-callback" className="field-label">Callback URL (optional)</label>
            <input
              id="key-callback"
              className="field-input font-mono text-xs"
              placeholder="https://their-site.com/otdms/callback"
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
            />
            <p className="mt-1 text-2xs text-ink-500">Can be added later.</p>
          </div>
        </div>
        <button
          type="button"
          className="btn-primary mt-3 w-full py-2 text-xs"
          disabled={createKey.isPending || label.trim().length === 0}
          onClick={() => createKey.mutate()}
        >
          {createKey.isPending ? 'Creating…' : 'Create API key'}
        </button>
      </Panel>

      {/* ------------------------------------------------ existing keys -- */}
      <Panel title="Keys" eyebrow={rows.length ? `${rows.length} total` : undefined} bodyClassName={rows.length ? 'p-0' : undefined}>
        {keys.isPending && <TableSkeleton rows={2} cols={2} />}
        {!keys.isPending && rows.length === 0 && (
          <EmptyState title="No keys yet" hint="This party cannot call the API until you create one." />
        )}

        {rows.length > 0 && (
          <ul className="divide-y divide-ink-800">
            {rows.map((k) => (
              <li key={k.keyId} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-ink-50">{k.label}</span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${
                          k.status === 'ACTIVE'
                            ? 'bg-signal-green/10 text-signal-green'
                            : 'bg-ink-700/50 text-ink-400'
                        }`}
                      >
                        <CircleDot className="h-2.5 w-2.5" />
                        {k.status === 'ACTIVE' ? 'Active' : 'Revoked'}
                      </span>
                    </div>
                    <p className="mt-0.5 break-all font-mono text-2xs text-ink-300">{k.keyId}</p>
                    <p className="mt-0.5 break-all font-mono text-2xs text-ink-500">
                      {k.callbackUrl ?? 'no callback URL set'}
                    </p>
                    <p className="mt-0.5 text-2xs text-ink-500">
                      created {when(k.createdAt)}
                      {' · '}
                      {k.lastUsedAt ? (
                        <span className="text-signal-green">last used {when(k.lastUsedAt)}</span>
                      ) : (
                        <span className="text-signal-amber">never used — not live yet</span>
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    <button
                      type="button"
                      className="btn-ghost gap-1 px-2 py-1 text-2xs"
                      onClick={() => void downloadPdf(k.keyId)}
                      title="Without the secret — that is only available when the key is created"
                    >
                      <FileDown className="h-3 w-3" /> PDF
                    </button>
                    <button
                      type="button"
                      className="btn-ghost gap-1 px-2 py-1 text-2xs"
                      onClick={() => {
                        setEditing(editing === k.keyId ? null : k.keyId);
                        setEditUrl(k.callbackUrl ?? '');
                      }}
                    >
                      <Pencil className="h-3 w-3" /> Callback
                    </button>
                    {k.status === 'ACTIVE' && (
                      <button
                        type="button"
                        className="btn-ghost gap-1 px-2 py-1 text-2xs text-signal-red"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(k.keyId)}
                      >
                        <Trash2 className="h-3 w-3" /> Revoke
                      </button>
                    )}
                  </div>
                </div>

                {editing === k.keyId && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      className="field flex-1 font-mono text-2xs"
                      placeholder="https://their-site.com/otdms/callback"
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn-primary px-3 py-1 text-2xs"
                      disabled={saveCallback.isPending}
                      onClick={() => saveCallback.mutate({ keyId: k.keyId, url: editUrl })}
                    >
                      Save
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Step({ n, label, hint, done }: { n: number; label: string; hint: string; done: boolean }) {
  return (
    <li className="flex gap-2.5">
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold ${
          done ? 'bg-signal-green/15 text-signal-green' : 'bg-ink-800 text-ink-400'
        }`}
      >
        {done ? <Check className="h-3 w-3" /> : n}
      </span>
      <div className="min-w-0">
        <p className={`text-xs ${done ? 'text-ink-300' : 'text-ink-50'}`}>{label}</p>
        <p className="text-2xs leading-relaxed text-ink-500">{hint}</p>
      </div>
    </li>
  );
}

function CopyRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mb-2">
      <p className="eyebrow">{label}</p>
      <div className="mt-0.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 font-mono text-2xs text-ink-100">
          {value}
        </code>
        <button type="button" className="btn-ghost shrink-0 gap-1 px-2 py-1 text-2xs" onClick={onCopy}>
          {copied ? <Check className="h-3 w-3 text-signal-green" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
