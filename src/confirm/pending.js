import { randomBytes } from 'node:crypto';

const TTL_MS = 5 * 60 * 1000;

// Process-local by design: restarting discards approvals. Only trusted code can
// register action handlers; Gemini never receives an execution/confirmation tool.
export function createConfirmations({ actions, now = Date.now, logger }) {
  const handlers = new Map(Object.entries(actions));
  const pending = new Map();

  function current(chatId) {
    const entry = pending.get(chatId);
    if (entry?.phase === 'ready' && now() >= entry.expiresAt) {
      pending.delete(chatId);
      return { expired: true };
    }
    return { entry };
  }

  function instructions(entry) {
    return `${entry.summary}\n\nPara aprobar: confirmar ${entry.code}\nPara descartar: cancelar\nVence en 5 minutos desde la propuesta. Puedes consultar: pendiente`;
  }

  return {
    async propose(chatId, type, payload, send) {
      const { entry } = current(chatId);
      if (entry) {
        await send(entry.phase === 'executing'
          ? 'La accion anterior ya esta en curso. Espera su resultado.'
          : 'Ya tienes una accion pendiente. Escribe pendiente para verla o cancelar antes de proponer otra.');
        return;
      }
      const handler = handlers.get(type);
      if (!handler) throw new Error('Unregistered confirmation action');
      // Validation and rendering belong to the action, not to model prose. Clone
      // both inputs so later edits cannot change what the owner approves.
      const snapshot = structuredClone(handler.prepare(structuredClone(payload)));
      const summary = handler.describe(structuredClone(snapshot));
      if (typeof summary !== 'string' || !summary.trim() || summary.length > 3000) {
        throw new Error('Action preview must be complete and fit in one message');
      }
      const proposal = { code: randomBytes(4).toString('hex'), summary,
        payload: snapshot, handler, phase: 'delivering' };
      pending.set(chatId, proposal);
      try {
        await send(instructions(proposal));
        if (pending.get(chatId) === proposal) {
          proposal.expiresAt = now() + TTL_MS;
          proposal.phase = 'ready';
        }
      } catch (err) {
        if (pending.get(chatId) === proposal) pending.delete(chatId);
        throw err;
      }
    },

    // Called only on actual owner messages, inside the per-chat conversation
    // queue. Return false for ordinary conversation, true for consumed commands.
    async handleMessage(chatId, text, send) {
      const command = text.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
      const confirmation = /^confirmar ([a-f0-9]{8})$/.exec(command);
      const control = /^(?:confirmar|cancelar|pendiente)(?:\s|$)/.test(command);
      const { entry, expired } = current(chatId);
      const bareYes = /^(?:si|si,? enviar|si,? confirmar|enviar|confirmo)[.!]?$/.test(command);
      if (!control && !((entry || expired) && bareYes)) return false;

      if (!entry) {
        await send(expired
          ? 'Esa solicitud vencio. Pide una nueva propuesta para revisarla y aprobarla.'
          : 'No hay ninguna accion pendiente. Las solicitudes vencen a los 5 minutos y se descartan al reiniciar.');
        return true;
      }
      if (entry.phase === 'executing') {
        await send('Esa accion ya esta en curso. No se ejecutara de nuevo; espera su resultado.');
        return true;
      }
      if (command === 'cancelar') {
        pending.delete(chatId);
        await send('Listo, pana. Accion cancelada.');
        return true;
      }
      if (entry.phase !== 'ready') {
        await send('Espera a recibir la propuesta completa antes de confirmar.');
        return true;
      }
      if (command === 'pendiente') {
        // Showing it again must not extend its lifetime.
        await send(instructions(entry));
        return true;
      }
      if (!confirmation || confirmation[1] !== entry.code) {
        await send(`No he ejecutado nada. Para aprobar esta propuesta escribe exactamente: confirmar ${entry.code}\nO escribe cancelar.`);
        return true;
      }

      // Consume the approval before awaiting external work. Never automatically
      // retry: a timeout may mean the provider performed the action anyway.
      entry.phase = 'executing';
      let result;
      try {
        result = await entry.handler.execute(entry.payload);
        if (typeof result !== 'string' || !result.trim()) throw new Error('Missing action result');
      } catch (err) {
        logger.error('confirmed action failed; approval consumed, no automatic retry');
        result = entry.handler.failureMessage?.(err) || 'No pude confirmar el resultado de la accion. No la voy a repetir automaticamente. ' +
          'Revisa el servicio antes de pedir una nueva propuesta para evitar duplicados.';
      } finally {
        if (pending.get(chatId) === entry) pending.delete(chatId);
      }
      // A send failure must never restore the consumed approval.
      await send(result);
      return true;
    },
  };
}
