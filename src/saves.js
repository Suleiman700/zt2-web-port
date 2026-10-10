// Named saved games (the Save / Load screens), kept in this browser's IndexedDB. A slot holds the
// map, the zoo (what the autosave keeps), the edited terrain (or null for the map's own) and a
// small picture for the Load screen. Details and data are stored apart so listing stays quick.
import { loadValue, saveValue, deleteValue, listValues } from './storage.js';

const INFO = 'saveinfo.', DATA = 'savedata.';

export async function listSaves() {
  return (await listValues(INFO)).map(([, v]) => v).sort((a, b) => b.date - a.date);
}

export async function writeSave(name, { map, zoo, terrain, preview }) {
  const ok = await saveValue(DATA + name, { map, zoo, terrain });
  if (ok) await saveValue(INFO + name, { name, map, date: Date.now(), preview });
  return ok;
}

export const readSave = (name) => loadValue(DATA + name);

export async function deleteSave(name) {
  await deleteValue(DATA + name);
  await deleteValue(INFO + name);
}
