import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, KeyRound, Copy, Check, Trash2, AlertTriangle } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, EmptyState, TableSkeleton, cn } from '@/components/primitives';
import type { ApiKeyDto, IssuedApiKeyDto } from '@/types';
import { when } from '@/lib/datetime';

/**
 * The credentials the party's own server calls our API with.
 *
 * Issued from here rather than from the API itself, because the API is for
 * servers and has no way to bootstrap its own access — somebody has to be
 * signed in as a person to create the first key.
 *
 * The secret is shown exactly once, in the panel below, and then never again.
 * That is a deliberate choice rather than a technical limit: a credential that
 * can be re-read from a dashboard is one that leaks the first time somebody
 * shares their screen. A lost secret is replaced, not recovered.
 */
export function PartyApiKeys() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [label, setLabel] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [issued, setIssued] = useState<IssuedApiKeyDto | null>(null);
  const [copied, setCopied] = useState<'keyId' | 'secret' | null>(null);

  const keys = useQuery<ApiKeyDto[]>({
    queryKey: ['party-api-keys'],
    queryFn: () => api.get<ApiKeyDto[]>('/party/api-keys'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<IssuedApiKeyDto>('/party/api-keys', {
        label: label.trim(),
        ...(callbackUrl.trim() ? { callbackUrl: callbackUrl.trim() } : {}),
      }),
    onSuccess: (data) => {
      setIssued(data);
      setLabel('');
      setCallbackUrl('');
      void queryClient.invalidateQueries({ queryKey: ['party-api-keys'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) => api.del(`/party/api-keys/${keyId}`),
    onSuccess: () => {
      toast.show('info', 'Key revoked. Any server still using it will start being refused.');
      void queryClient.invalidateQueries({ queryKey: ['party-api-keys'] });
    },
    onError: (e) => toast.show('error', (e as ApiRequestError).message),
  });

  const copy = async (value: string, which: 'keyId' | 'secret'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.show('error', 'Could not copy — select the text and copy it by hand.');
    }
  };

  const active = keys.data?.filter((k) => k.status === 'ACTIVE') ?? [];

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Party</p>
        <h1 className="font-display text-xl font-semibold text-ink-50">API keys</h1>
        <p className="mt-1 text-xs text-ink-400">
          What your server signs its requests with. Your customers never see these.
        </p>
      </div>

      {/* Shown once, and it says so. Anything less emphatic and somebody
          closes the page assuming they can come back for it. */}
      {issued && (
        <Panel
          title="Your new key"
          eyebrow="the secret is shown once and cannot be recovered"
          action={<KeyRound className="h-4 w-4 text-signal-amber" />}
        >
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-signal-amber/40 bg-signal-amber/10 px-3 py-2.5 text-2xs leading-relaxed text-signal-amber">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Copy the secret into your server&apos;s configuration now. We cannot show it again — if it is
                lost, revoke this key and make a new one.
              </span>
            </div>

            <CopyRow label="Key ID" value={issued.keyId} copied={copied === 'keyId'} onCopy={() => void copy(issued.keyId, 'keyId')} />
            <CopyRow label="Secret" value={issued.secret} copied={copied === 'secret'} onCopy={() => void copy(issued.secret, 'secret')} />

            <button type="button" onClick={() => setIssued(null)} className="btn-secondary w-full">
              I have saved it
            </button>
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        <Panel title="Create a key" eyebrow="one per system you integrate" action={<KeyRound className="h-4 w-4 text-ink-400" />}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (label.trim() && !create.isPending) create.mutate();
            }}
            className="space-y-3.5"
          >
            <div>
              <label htmlFor="key-label" className="field-label">Name</label>
              <input
                id="key-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Production checkout"
                className="field-input"
              />
              <p className="mt-1 text-2xs text-ink-500">
                So you can tell them apart later and revoke the right one.
              </p>
            </div>

            <div>
              <label htmlFor="key-callback" className="field-label">Callback URL (optional)</label>
              <input
                id="key-callback"
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                placeholder="https://your-site.com/otdms/callback"
                className="field-input font-mono"
              />
              <p className="mt-1 text-2xs text-ink-500">
                Where we tell you an outcome. Stored per key, so staging and production can differ. Each call
                can override it.
              </p>
            </div>

            <button type="submit" disabled={!label.trim() || create.isPending} className="btn-primary w-full">
              {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><KeyRound className="h-4 w-4" /> Create key</>}
            </button>
          </form>
        </Panel>

        <Panel title="Your keys" bodyClassName={keys.data?.length ? 'p-0' : undefined}>
          {keys.isPending && <TableSkeleton rows={2} cols={4} />}
          {keys.data?.length === 0 && (
            <EmptyState title="No keys yet" hint="Create one to start calling the API from your server." />
          )}
          {keys.data && keys.data.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-left">
                    <th className="px-4 py-2.5 eyebrow font-normal">Name</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Key ID</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Last used</th>
                    <th className="px-4 py-2.5 eyebrow font-normal">Status</th>
                    <th className="px-4 py-2.5 eyebrow font-normal"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {keys.data.map((k) => (
                    <tr key={k.keyId} className="transition-colors hover:bg-ink-850/60">
                      <td className="px-4 py-3">
                        <p className="text-xs text-ink-100">{k.label}</p>
                        {k.callbackUrl && (
                          <p className="mt-0.5 max-w-[32ch] truncate font-mono text-2xs text-ink-500">{k.callbackUrl}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-2xs text-ink-400">{k.keyId}</td>
                      <td className="px-4 py-3 font-mono tnum text-2xs text-ink-400">
                        {/* Never used is worth seeing plainly: it usually means
                            an integration that was set up and never finished. */}
                        {k.lastUsedAt
                          ? when(k.lastUsedAt)
                          : 'never'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium',
                          k.status === 'ACTIVE' ? 'bg-signal-green/10 text-signal-green' : 'bg-ink-700/60 text-ink-400',
                        )}>
                          {k.status === 'ACTIVE' ? 'Active' : 'Revoked'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {k.status === 'ACTIVE' && (
                          <button
                            type="button"
                            onClick={() => {
                              // Irreversible and immediate — a server using it
                              // starts failing the moment this lands.
                              if (active.length === 1 && !window.confirm(
                                'This is your only active key. Revoking it will stop your integration until you create another. Continue?',
                              )) return;
                              revoke.mutate(k.keyId);
                            }}
                            disabled={revoke.isPending}
                            className="btn-ghost p-1.5"
                            aria-label={`Revoke ${k.label}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-signal-red" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel title="How to sign a request" eyebrow="the same two functions on both sides">
        <div className="space-y-3 text-xs leading-relaxed text-ink-300">
          <p>Send three headers with every call:</p>
          <div className="overflow-x-auto rounded-md border border-ink-700 bg-ink-850 p-3">
            <pre className="font-mono text-2xs text-ink-200">{`x-otdms-key:        <your key id>
x-otdms-timestamp:  <seconds since the epoch>
x-otdms-signature:  <HMAC-SHA256 of the payload below, hex>`}</pre>
          </div>
          <p>The signed payload is four lines joined with a newline:</p>
          <div className="overflow-x-auto rounded-md border border-ink-700 bg-ink-850 p-3">
            <pre className="font-mono text-2xs text-ink-200">{`<timestamp>
<METHOD>
<full path, e.g. /api/v1/api/payin>
<the exact request body bytes, or "" for a GET>`}</pre>
          </div>
          <p className="text-ink-400">
            Sign the exact bytes you send. Re-serialising the object first is the commonest way this goes
            wrong — key order and spacing are free to differ, and the signature is then over something you
            did not send. Requests more than five minutes old are refused, so keep your clock roughly right.
          </p>
          <p className="text-ink-400">
            Callbacks are signed the same way, with the same secret, over your own callback path. Check them:
            an unverified callback endpoint is a public &ldquo;mark my order paid&rdquo; button.
          </p>
        </div>
      </Panel>
    </div>
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
    <div>
      <p className="field-label">{label}</p>
      <div className="flex gap-2">
        <input readOnly value={value} className="field-input font-mono text-2xs" onFocus={(e) => e.target.select()} />
        <button type="button" onClick={onCopy} className="btn-secondary shrink-0 px-3" aria-label={`Copy ${label}`}>
          {copied ? <Check className="h-4 w-4 text-signal-green" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
