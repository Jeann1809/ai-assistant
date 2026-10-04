import { memoryKey, memoryValue, MAX_FACTS } from './long-term.js';
import { createMemoryEmbedder } from './embeddings.js';

const HELP = 'Usa /recordar clave = dato, /recuerdos [pagina] o /olvidar clave. Repite una clave para corregirla.';

export function createFactMemory({ store, embed = createMemoryEmbedder(), logger }) {
  async function saveFact(chatId, key, value, expected) {
    let vector = null;
    try { vector = await embed(`${key}: ${value}`, 'document'); }
    catch { logger.warn('memory embedding unavailable; saving text only'); }
    if (expected !== undefined && (store.list(chatId).find((row) => row.key === key)?.value ?? null) !== expected) {
      return 'Ese recuerdo cambio desde la propuesta. No lo reemplace; pide una nueva propuesta.';
    }
    store.save(chatId, key, value, vector);
    return `Recuerdo guardado: ${key} = ${value}` +
      (vector ? '' : '\nLa busqueda por significado no esta disponible; usare palabras. Repite /recordar mas tarde para indexarlo.');
  }
  return {
    prepareProposal(chatId, input) {
      const key = memoryKey(input.key);
      const value = memoryValue(input.value);
      const previous = store.list(chatId).find((row) => row.key === key)?.value ?? null;
      if (previous === value) return null;
      return { chatId, key, value, previous };
    },
    describeProposal: ({ key, value, previous }) =>
      `*Queres que recuerde esto?*\nClave: ${key}\n` +
      (previous === null ? 'Nuevo recuerdo.\n' : `Reemplaza: ${previous}\n`) + `Guardar: ${value}`,
    async saveProposal({ chatId, key, value, previous }) {
      try { return await saveFact(chatId, key, value, previous); }
      catch {
        logger.warn('confirmed memory save failed');
        return 'No pude guardar el recuerdo. Revisa el almacenamiento y pide una nueva propuesta.';
      }
    },
    prepareProposals(chatId, inputs) {
      if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 5) throw new Error('Usa de 1 a 5 recuerdos.');
      const current = new Map(store.list(chatId).map((row) => [row.key, row.value]));
      const memories = inputs.map((input) => ({ key: memoryKey(input.key), value: memoryValue(input.value) }));
      if (new Set(memories.map((memory) => memory.key)).size !== memories.length) throw new Error('Claves repetidas.');
      if (current.size + memories.filter((memory) => !current.has(memory.key)).length > MAX_FACTS) throw new Error('Limite de recuerdos.');
      return { chatId, memories: memories.filter((memory) => current.get(memory.key) !== memory.value)
        .map((memory) => ({ ...memory, previous: current.get(memory.key) ?? null })) };
    },
    describeProposals({ memories }) {
      return memories.map(({ key, value, previous }, index) =>
        `*Recuerdo ${index + 1}/${memories.length} del lote*\nClave: ${key}\n` +
        (previous === null ? 'Nuevo recuerdo.\n' : `Reemplaza: ${previous}\n`) + `Guardar: ${value}`);
    },
    async saveProposals({ chatId, memories }) {
      try {
        const rows = [];
        // Sequential calls respect the free tier. The database transaction starts
        // only after embeddings finish, so no lock spans network requests.
        for (const memory of memories) {
          let vector = null;
          try { vector = await embed(`${memory.key}: ${memory.value}`, 'document'); }
          catch { logger.warn('batch memory embedding unavailable; saving text only'); }
          rows.push({ ...memory, vector });
        }
        store.saveBatch(chatId, rows);
        return `Recuerdos guardados (${rows.length}):\n` + rows.map((row) => `- ${row.key} = ${row.value}`).join('\n') +
          (rows.some((row) => !row.vector) ? '\nAlgunos quedaron sin busqueda por significado; usare palabras para esos recuerdos.' : '');
      } catch (err) {
        logger.warn('confirmed batch memory save failed');
        return err.code === 'STALE' ? err.message : 'No pude guardar el lote de recuerdos. No se guardo ninguno; revisa el almacenamiento y el limite de 100 recuerdos.';
      }
    },
    async handleMessage(chatId, text, send) {
      if (!/^\/(recordar|recuerdos|olvidar)(?:\s|$)/i.test(text.trim())) return false;
      let reply;
      try {
        const input = text.trim();
        const save = /^\/recordar\s+([^=]+)=([\s\S]+)$/i.exec(input);
        const forget = /^\/olvidar\s+(\S+)$/i.exec(input);
        const list = /^\/recuerdos(?:\s+(\d+))?$/i.exec(input);
        if (save) {
          const key = memoryKey(save[1]);
          const value = memoryValue(save[2]);
          reply = await saveFact(chatId, key, value);
        } else if (forget) {
          reply = store.forget(chatId, forget[1])
            ? 'Recuerdo borrado de la memoria larga. Puede seguir mencionado en el historial reciente o en copias de seguridad.'
            : 'No existe un recuerdo con esa clave.';
        } else if (list) {
          const page = Number(list[1] ?? 1);
          const rows = store.list(chatId);
          const pages = Math.max(1, Math.ceil(rows.length / 5));
          if (!Number.isSafeInteger(page) || page < 1 || page > pages) reply = `Usa una pagina entre 1 y ${pages}.`;
          else reply = rows.length ? `Recuerdos (${page}/${pages}):\n` + rows.slice((page - 1) * 5, page * 5)
            .map((row) => `- ${row.key} = ${row.value}`).join('\n') : 'No hay recuerdos guardados.';
        } else reply = HELP;
      } catch {
        logger.warn('memory command failed');
        reply = 'No pude completar el cambio. Usa claves de hasta 40 letras/numeros/guiones y datos de 1 a 300 caracteres en una linea; maximo 100 recuerdos. Si el formato esta bien, revisa el almacenamiento.';
      }
      await send(reply);
      return true;
    },
    async recall(chatId, text) {
      try {
        if (!store.list(chatId).length) return { facts: [] };
        let vector = null;
        try { vector = await embed(text.slice(0, 2000), 'query'); }
        catch { logger.warn('semantic recall unavailable; using keyword search'); }
        return { facts: store.search(chatId, text, vector), warning: vector ? null :
          'Nota: hoy solo pude buscar recuerdos por palabras; puede faltar contexto.' };
      } catch {
        logger.warn('long-term memory unavailable');
        return { facts: [], warning: 'Nota: no pude consultar la memoria larga para esta respuesta.' };
      }
    },
  };
}
