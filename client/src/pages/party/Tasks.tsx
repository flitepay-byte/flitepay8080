import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Loader2, X, AlertCircle, Landmark, Smartphone, Coins, Upload, FileText } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { Panel, Money, StatusChip, EmptyState, ErrorState, TableSkeleton, TaskSearchInput, cn, Pagination } from '@/components/primitives';
import { TASK_STATES, type Task, type Paginated, type TaskState, type PayoutMethodType } from '@/types';

export function PartyTasks() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const status = (searchParams.get('status') as TaskState | null) ?? '';
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page: String(page), limit: '20' });
  if (status) params.set('status', status);
  if (search) params.set('search', search);

  const tasks = useQuery<Paginated<Task>>({
    queryKey: ['party-tasks', status, search, page],
    queryFn: () => api.get<Paginated<Task>>(`/party/tasks?${params.toString()}`),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Party</p>
          <h1 className="font-display text-xl font-semibold text-ink-50">Tasks</h1>
        </div>
        <button type="button" onClick={() => setCreating(true)} className="btn-primary">
          <Plus className="h-4 w-4" /> New task
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <TaskSearchInput
          onChange={(value) => { setSearch(value); setPage(1); }}
          placeholder="Task number, customer name or reference"
        />
        <select
          value={status}
          onChange={(e) => {
            const next = e.target.value;
            setSearchParams(next ? { status: next } : {});
            setPage(1);
          }}
          aria-label="Filter by state"
          className="field-input w-auto"
        >
          <option value="">All states</option>
          {TASK_STATES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>
          ))}
        </select>
      </div>

      <Panel bodyClassName={tasks.data?.items.length ? 'p-0' : undefined}>
        {tasks.isPending && <TableSkeleton rows={5} cols={4} />}
        {tasks.isError && <ErrorState message="Could not load tasks." onRetry={() => void tasks.refetch()} />}
        {tasks.data?.items.length === 0 && (
          <EmptyState
            title={search ? 'Nothing matched' : 'No tasks yet'}
            hint={
              search
                ? 'No task matches that number, customer name or reference.'
                : 'Create one, or import a batch from a CSV.'
            }
            action={
              search ? undefined : (
                <button type="button" onClick={() => setCreating(true)} className="btn-primary">
                  <Plus className="h-4 w-4" /> New task
                </button>
              )
            }
          />
        )}
        {tasks.data && tasks.data.items.length > 0 && (
          <>
            <ul className="divide-y divide-ink-800">
              {tasks.data.items.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/party/tasks/${task.id}`)}
                    className="flex w-full flex-wrap items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-ink-850/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2.5">
                        <span className="font-mono tnum text-sm text-ink-50">{task.taskCode}</span>
                        <span className="font-mono text-2xs text-ink-400">{task.externalRef}</span>
                      </div>
                      <p className="mt-1 text-2xs text-ink-400">{task.customerName}</p>
                    </div>
                    <StatusChip status={task.status} size="sm" />
                    <Money showUsdt={false} amount={task.amount} className="w-24 text-right text-sm text-ink-50" />
                  </button>
                </li>
              ))}
            </ul>
            <Pagination page={page} totalPages={tasks.data.totalPages} onChange={setPage} />
          </>
        )}
      </Panel>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

const PAYOUT_TABS: Array<{ type: PayoutMethodType; label: string; icon: typeof Landmark }> = [
  { type: 'BANK', label: 'Bank transfer', icon: Landmark },
  { type: 'UPI', label: 'UPI', icon: Smartphone },
  { type: 'USDT', label: 'USDT', icon: Coins },
];

const UPI_REGEX = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
const IFSC_REGEX = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;
const WALLET_REGEX = /^[A-Za-z0-9]{20,64}$/;

/** Suggestions only — the field stays free text, since the beneficiary may bank anywhere. */
const COMMON_BANKS = [
  'State Bank of India (SBI)',
  'HDFC Bank',
  'ICICI Bank',
  'Axis Bank',
  'Punjab National Bank (PNB)',
  'Bank of Baroda',
  'Kotak Mahindra Bank',
  'Canara Bank',
  'Union Bank of India',
  'IndusInd Bank',
  'IDFC FIRST Bank',
  'Yes Bank',
];

function CreateDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [customerName, setCustomerName] = useState('');
  const [amount, setAmount] = useState('');
  const [payoutType, setPayoutType] = useState<PayoutMethodType>('BANK');
  const [bankName, setBankName] = useState('');
  const [accountHolderName, setAccountHolderName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifscCode, setIfscCode] = useState('');
  const [upiId, setUpiId] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [walletAddress, setWalletAddress] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!customerName.trim()) next['customerName'] = 'Enter a name';
    const amountNum = Number(amount);
    if (!amount.trim() || !(amountNum > 0)) next['amount'] = 'Enter an amount greater than zero';

    if (payoutType === 'BANK') {
      if (bankName.trim().length < 2) next['bankName'] = 'Enter the bank name, e.g. SBI or HDFC Bank';
      if (!accountHolderName.trim()) next['accountHolderName'] = 'Enter the account holder name';
      if (!/^[0-9]{6,30}$/.test(accountNumber.trim())) next['accountNumber'] = 'Enter a valid account number (digits only)';
      if (!IFSC_REGEX.test(ifscCode.trim())) next['ifscCode'] = 'Enter a valid IFSC code, e.g. HDFC0001234';
    } else if (payoutType === 'UPI') {
      if (!UPI_REGEX.test(upiId.trim())) next['upiId'] = 'Enter a valid UPI ID, e.g. name@bank';
    } else {
      if (!WALLET_REGEX.test(walletAddress.trim())) next['walletAddress'] = 'Enter a valid wallet address (20-64 letters/numbers)';
    }
    return next;
  };

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFormError(null);
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('customerName', customerName.trim());
      form.append('amount', amount.trim());
      form.append('payoutType', payoutType);
      if (payoutType === 'BANK') {
        form.append('bankName', bankName.trim());
        form.append('accountHolderName', accountHolderName.trim());
        form.append('accountNumber', accountNumber.trim());
        form.append('ifscCode', ifscCode.trim());
      } else if (payoutType === 'UPI') {
        form.append('upiId', upiId.trim());
        if (screenshot) form.append('screenshot', screenshot);
      } else {
        form.append('walletAddress', walletAddress.trim());
      }

      const task = await api.upload<Task>('/party/tasks', form);
      toast.show('success', 'Task created and offered to captains.');
      void queryClient.invalidateQueries({ queryKey: ['party-tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['party-dashboard'] });
      onClose();
      // Land on the detail page so the party can immediately copy the
      // system-generated reference and relay it to their customer.
      navigate(`/party/tasks/${task.id}`);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        const next: Record<string, string> = {};
        for (const [field, messages] of Object.entries(err.fieldErrors)) {
          if (messages[0]) next[field] = messages[0];
        }
        setFieldErrors(next);
        setFormError(err.message);
        return;
      }
      setFormError('Could not create the task.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-ink-950/80" onClick={onClose} aria-label="Close" />
      <div className="panel relative max-h-[90vh] w-full max-w-lg overflow-y-auto shadow-panel animate-slide-up">
        <header className="sticky top-0 flex items-center justify-between border-b border-ink-700 bg-ink-900 px-5 py-3.5">
          <h2 className="font-display text-sm font-semibold text-ink-50">New task</h2>
          <button type="button" onClick={onClose} className="btn-ghost p-1" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <form onSubmit={onSubmit} className="space-y-4 px-5 py-4" noValidate>
          <div>
            <label htmlFor="customerName" className="field-label">Beneficiary name</label>
            <input
              id="customerName"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              className={cn('field-input', fieldErrors['customerName'] && 'border-signal-red')}
              autoFocus
            />
            {fieldErrors['customerName'] && <p className="field-error"><AlertCircle className="h-3 w-3" />{fieldErrors['customerName']}</p>}
          </div>

          <div>
            <span className="field-label">Payout method</span>
            <div className="grid grid-cols-3 gap-1.5 rounded-md border border-ink-700 bg-ink-850 p-1">
              {PAYOUT_TABS.map((tab) => {
                const Icon = tab.icon;
                const active = payoutType === tab.type;
                return (
                  <button
                    key={tab.type}
                    type="button"
                    onClick={() => setPayoutType(tab.type)}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded px-2 py-2 text-2xs font-medium transition-colors',
                      active ? 'bg-ink-700 text-ink-50 shadow-rail' : 'text-ink-400 hover:text-ink-100',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {payoutType === 'BANK' && (
            <div className="space-y-3.5 rounded-panel border border-ink-700 bg-ink-850/40 p-3.5">
              <div>
                <label htmlFor="bankName" className="field-label">Bank name</label>
                <input
                  id="bankName"
                  list="bank-suggestions"
                  placeholder="SBI, HDFC Bank, …"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  className={cn('field-input', fieldErrors['bankName'] && 'border-signal-red')}
                />
                <datalist id="bank-suggestions">
                  {COMMON_BANKS.map((bank) => (
                    <option key={bank} value={bank} />
                  ))}
                </datalist>
                {fieldErrors['bankName'] && <p className="field-error"><AlertCircle className="h-3 w-3" />{fieldErrors['bankName']}</p>}
              </div>
              <div>
                <label htmlFor="accountHolderName" className="field-label">Account holder name</label>
                <input
                  id="accountHolderName"
                  value={accountHolderName}
                  onChange={(e) => setAccountHolderName(e.target.value)}
                  className={cn('field-input', fieldErrors['accountHolderName'] && 'border-signal-red')}
                />
                {fieldErrors['accountHolderName'] && <p className="field-error"><AlertCircle className="h-3 w-3" />{fieldErrors['accountHolderName']}</p>}
              </div>
              <div>
                <label htmlFor="accountNumber" className="field-label">Account number</label>
                <input
                  id="accountNumber"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  className={cn('field-input font-mono tnum', fieldErrors['accountNumber'] && 'border-signal-red')}
                />
                {fieldErrors['accountNumber'] && <p className="field-error"><AlertCircle className="h-3 w-3" />{fieldErrors['accountNumber']}</p>}
              </div>
              <div>
                <label htmlFor="ifscCode" className="field-label">IFSC code</label>
                <input
                  id="ifscCode"
                  placeholder="HDFC0001234"
                  value={ifscCode}
                  onChange={(e) => setIfscCode(e.target.value.toUpperCase())}
                  className={cn('field-input font-mono', fieldErrors['ifscCode'] && 'border-signal-red')}
                />
                {fieldErrors['ifscCode'] && <p className="field-error"><AlertCircle className="h-3 w-3" />{fieldErrors['ifscCode']}</p>}
              </div>
            </div>
          )}

          {payoutType === 'UPI' && (
            <div className="space-y-3.5 rounded-panel border border-ink-700 bg-ink-850/40 p-3.5">
              <div>
                <label htmlFor="upiId" className="field-label">UPI ID</label>
                <input
                  id="upiId"
                  placeholder="name@bank"
                  value={upiId}
                  onChange={(e) => setUpiId(e.target.value)}
                  className={cn('field-input font-mono', fieldErrors['upiId'] && 'border-signal-red')}
                />
                {fieldErrors['upiId'] && <p className="field-error"><AlertCircle className="h-3 w-3" />{fieldErrors['upiId']}</p>}
              </div>
              <div>
                <span className="field-label">Screenshot (optional)</span>
                {screenshot ? (
                  <div className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-850 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-200">
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{screenshot.name}</span>
                    </span>
                    <button type="button" onClick={() => setScreenshot(null)} className="btn-ghost shrink-0 p-1" aria-label="Remove file">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-ink-700 px-3 py-3 text-xs text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200">
                    <Upload className="h-3.5 w-3.5" />
                    Attach a PNG or JPG
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      onChange={(e) => setScreenshot(e.target.files?.[0] ?? null)}
                    />
                  </label>
                )}
              </div>
            </div>
          )}

          {payoutType === 'USDT' && (
            <div className="space-y-3.5 rounded-panel border border-ink-700 bg-ink-850/40 p-3.5">
              <div>
                <label htmlFor="walletAddress" className="field-label">Wallet address</label>
                <input
                  id="walletAddress"
                  value={walletAddress}
                  onChange={(e) => setWalletAddress(e.target.value)}
                  className={cn('field-input font-mono', fieldErrors['walletAddress'] && 'border-signal-red')}
                />
                {fieldErrors['walletAddress'] && <p className="field-error"><AlertCircle className="h-3 w-3" />{fieldErrors['walletAddress']}</p>}
              </div>
            </div>
          )}

          <div>
            <label htmlFor="amount" className="field-label">Amount (DMC)</label>
            <input
              id="amount"
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={cn('field-input font-mono tnum', fieldErrors['amount'] && 'border-signal-red')}
            />
            {fieldErrors['amount'] && <p className="field-error"><AlertCircle className="h-3 w-3" />{fieldErrors['amount']}</p>}
          </div>

          <p className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5 text-2xs text-ink-400">
            Fictional payout details only — nothing here ever touches a real bank, UPI, or crypto rail. A tracking
            reference is also generated automatically for you to relay to your customer.
          </p>

          {formError && (
            <div className="flex items-start gap-2 rounded-md border border-signal-red/40 bg-signal-red/10 px-3 py-2.5">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-red" />
              <p className="text-xs text-ink-100">{formError}</p>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={submitting} className="btn-primary flex-1">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create task'}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
