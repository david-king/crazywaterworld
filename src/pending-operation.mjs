import { createOperationLog } from './operation-log.mjs';

// Business modules own their confirmation evidence. This helper only manages
// one reservation and distinguishes a rejected write from an uncertain result.
export function createPendingOperation(ledger, {
  request,
  isNotSent = error => error.notSent === true,
  client,
  module,
  label,
}) {
  let ticket = null;
  let started = false;
  let sent = false;
  let settled = false;
  let log = null;

  function finishLog(phase, result, extra) {
    log?.phase(phase, result, extra);
    log?.close();
  }

  return {
    get operationId() { return log?.operationId; },
    reserve(...args) {
      if (ticket || settled) throw new Error('操作已经预留或结算');
      ticket = ledger.reserve(...args);
      if (client) log = createOperationLog(client, {
        ticket, operationId: ticket.id, dedupeKey: args[3]?.uniqueKey, module, request, label,
      });
      return ticket;
    },
    async send(work) {
      if (started || settled) throw new Error('操作已经提交，不能重复发送');
      started = true;
      const result = await work();
      sent = true;
      return result;
    },
    confirm() {
      if (!ticket || settled) return;
      ledger.confirm(ticket);
      settled = true;
      finishLog('confirmed', 'confirmed');
    },
    cancel() {
      if (!ticket || started || settled) return;
      ledger.cancel(ticket);
      settled = true;
      finishLog('cancelled', 'not-sent');
    },
    fail(error, { handled = false } = {}) {
      if (settled) return { rejected: false, pending: false };
      if (handled) {
        // The business module already closed this reservation atomically.
        settled = true;
        finishLog('failed', 'failed', { reason: error.message });
        return { rejected: false, pending: false };
      }
      const notSent = !sent && isNotSent(error);
      const rejected = notSent || !!error.prompt && error.request === request;
      if (ticket && rejected) {
        ledger.cancel(ticket);
        settled = true;
      }
      const cancellation = notSent ? 'not-sent' : 'rejected';
      if (ticket) finishLog(rejected ? 'cancelled' : 'unknown', rejected ? cancellation : 'pending', { reason: error.message });
      return { rejected, pending: !!ticket && !settled };
    },
  };
}
