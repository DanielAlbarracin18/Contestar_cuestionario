// ============================================================
//  storage.js  —  capa de datos compartida entre las páginas
// ============================================================

const STORAGE_KEY = '***';

// ---------- Migración de formatos legados (days/day → Temas/Tema) ----------

/**
 * Torneos creados antes de este cambio guardaban el contenido buffet como
 * `buffetData.days` (con `day` numérico) y las asignaciones como
 * `participantDays`. Esta función detecta ese formato viejo y lo convierte
 * al formato actual (`buffetData.Temas` con `Tema`, y `participantTemas`)
 * sin perder ningún dato. Se ejecuta automáticamente al cargar los torneos.
 * Devuelve true si modificó el objeto `t` (para saber si hay que re-guardar).
 */
function migrateLegacyFields(t) {
  let changed = false;

  if (t.buffetData && Array.isArray(t.buffetData.days) && !t.buffetData.Temas) {
    t.buffetData = {
      Temas: t.buffetData.days.map(d => ({ Tema: d.day, preguntas: d.preguntas || [] }))
    };
    changed = true;
  }

  if (t.participantDays && !t.participantTemas) {
    t.participantTemas = t.participantDays;
    delete t.participantDays;
    changed = true;
  }

  return changed;
}

export function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : [];
    let changed = false;
    data.forEach(t => { if (migrateLegacyFields(t)) changed = true; });
    if (changed) saveAll(data); // persistimos la migración para que sea de una sola vez
    return data;
  } catch {
    return [];
  }
}

export function saveAll(tournaments) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tournaments));
  } catch (e) {
    console.error('No se pudo guardar:', e);
  }
}

export function getTournament(id) {
  return loadAll().find(t => t.id === id) || null;
}

export function saveTournament(updated) {
  const all = loadAll();
  const idx = all.findIndex(t => t.id === updated.id);
  if (idx >= 0) all[idx] = updated;
  else all.push(updated);
  saveAll(all);
}

export function deleteTournament(id) {
  saveAll(loadAll().filter(t => t.id !== id));
}

// ---------- Round-robin (método del círculo) ----------
// totalRounds (opcional): cantidad de jornadas que se quieren, SIN importar cuántos
// participantes haya (en las competencias es la cantidad de temas).
//  - Si el ciclo todos-contra-todos alcanza de sobra, se corta en totalRounds.
//  - Si faltan jornadas, el orden de enfrentamientos se repite en bucle desde el
//    principio; en cada vuelta impar se invierten local y visitante.
// Sin totalRounds se genera un ciclo completo (comportamiento de siempre).
export function generateRounds(participants, totalRounds) {
  let list = [...participants];
  if (list.length < 2) return [];
  if (list.length % 2 !== 0) list.push(null); // null = bye
  const n = list.length;
  const cycle = [];
  let arr = [...list];

  for (let r = 0; r < n - 1; r++) {
    const matches = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a !== null && b !== null)
        matches.push({ home: a, away: b, result: null }); // result = null hasta que se evalúe
    }
    cycle.push(matches);
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed, ...rest];
  }

  const total = Number.isInteger(totalRounds) && totalRounds >= 1 ? totalRounds : cycle.length;
  const rounds = [];
  for (let k = 0; k < total; k++) {
    const vuelta = Math.floor(k / cycle.length);
    const swap = vuelta % 2 === 1;
    rounds.push(cycle[k % cycle.length].map(m =>
      swap ? { home: m.away, away: m.home, result: null } : { home: m.home, away: m.away, result: null }));
  }
  return rounds;
}

// ---------- Agregar participantes a un torneo ya creado ----------

// Invierte un `result` guardado cuando el par (A,B) aparece ahora como (B,A).
function flipResult(r) {
  if (!r) return null;
  const flipped = { ...r };
  if ('homeScore' in flipped || 'awayScore' in flipped) {
    [flipped.homeScore, flipped.awayScore] = [flipped.awayScore, flipped.homeScore];
  }
  if ('extraHome' in flipped || 'extraAway' in flipped) {
    [flipped.extraHome, flipped.extraAway] = [flipped.extraAway, flipped.extraHome];
  }
  if (flipped.absent && typeof flipped.absent === 'object') {
    flipped.absent = { home: !!flipped.absent.away, away: !!flipped.absent.home };
  } else if (flipped.absentSide === 'home') flipped.absentSide = 'away';
  else if (flipped.absentSide === 'away') flipped.absentSide = 'home';
  if (Array.isArray(flipped.questionScores)) {
    flipped.questionScores = flipped.questionScores.map(s => ({
      ...s, homeQ: s.awayQ, awayQ: s.homeQ, homeC: s.awayC, awayC: s.homeC
    }));
  }
  return flipped;
}

// Invierte un `progress` (evaluación a medias) guardado, igual criterio que flipResult.
function flipProgress(p) {
  if (!p) return null;
  const flipped = { ...p };
  if (flipped.extraScores) {
    flipped.extraScores = { home: flipped.extraScores.away, away: flipped.extraScores.home };
  }
  if (Array.isArray(flipped.turnData)) {
    flipped.turnData = flipped.turnData.map(td => ({ ...td, home: td.away, away: td.home }));
  }
  return flipped;
}

// Reconstruye t.rounds con los participantes actuales y `total` jornadas, conservando
// lo ya evaluado / a medias. Como con el bucle un mismo par puede enfrentarse varias
// veces, cada enfrentamiento se identifica por (par, n.º de vez que aparece).
// Nunca recorta jornadas que ya tengan resultados.
function rebuildRounds(t, total) {
  const pairKey = (a, b) => [a, b].sort().join('\u241f');
  const savedByPair = new Map();
  const veces = new Map();
  let ultimaConDatos = 0;
  (t.rounds || []).forEach((round, ri) => {
    (round || []).forEach(m => {
      const base = pairKey(m.home, m.away);
      const k = veces.get(base) || 0;
      veces.set(base, k + 1);
      if (m.result || m.progress) {
        ultimaConDatos = ri + 1;
        savedByPair.set(`${base}#${k}`, { home: m.home, result: m.result || null, progress: m.progress || null });
      }
    });
  });

  const objetivo = Number.isInteger(total) && total >= 1 ? Math.max(total, ultimaConDatos) : undefined;
  const newRounds = generateRounds(t.participants, objetivo);
  const veces2 = new Map();
  let placed = 0;
  newRounds.forEach(round => {
    round.forEach(m => {
      const base = pairKey(m.home, m.away);
      const k = veces2.get(base) || 0;
      veces2.set(base, k + 1);
      const saved = savedByPair.get(`${base}#${k}`);
      if (!saved) return;
      placed++;
      const swapped = saved.home !== m.home;
      m.result = swapped ? flipResult(saved.result) : saved.result;
      m.progress = swapped ? flipProgress(saved.progress) : saved.progress;
    });
  });

  // Con el bucle un par puede haberse jugado dos veces y el nuevo calendario ya no
  // tener esa segunda vuelta: para NO perder nada, las jornadas con datos se dejan
  // tal cual estaban y solo se renuevan las demás.
  if (placed < savedByPair.size) {
    const viejas = t.rounds || [];
    newRounds.forEach((r, i) => {
      const vieja = viejas[i];
      if (vieja && vieja.some(m => m.result || m.progress)) { newRounds[i] = vieja; return; }
      r.forEach(m => { m.result = null; delete m.progress; }); // sin duplicar lo ya jugado
    });
  }
  t.rounds = newRounds;
}

/**
 * Agrega participantes a un torneo ya creado y regenera el calendario
 * round-robin entre TODOS los participantes (los que ya estaban + los nuevos).
 * Si el torneo tiene `totalRounds` (solo shared + temas asignados), la cantidad de jornadas se mantiene fija
 * (el orden de enfrentamientos se repite en bucle si hace falta); si no, crece
 * con la gente agregada como antes.
 *
 * Los enfrentamientos que ya se habían jugado (o quedaron a medias) entre dos
 * participantes que ya estaban en el torneo se vuelven a aplicar sobre el
 * nuevo calendario buscando el mismo par sin importar quién quedó de local o
 * visitante, así no se pierde nada de lo ya evaluado.
 *
 * Muta `t` directamente (participants, rounds, y — según el tipo de
 * contenido — participantTemas / participantContent / questionsByRound).
 * No guarda; hay que llamar a `saveTournament(t)` después.
 *
 * Devuelve { added: string[] } con los nombres realmente incorporados
 * (ignora duplicados ya existentes y strings vacíos).
 */
export function addParticipants(t, newNames) {
  const cleaned = (newNames || []).map(n => String(n).trim()).filter(Boolean);
  const toAdd = [];
  cleaned.forEach(n => {
    if (!t.participants.includes(n) && !toAdd.includes(n)) toAdd.push(n);
  });
  if (!toAdd.length) return { added: [] };

  // 1-3) Nueva lista de participantes + calendario regenerado (lo ya jugado se conserva).
  //      Si el torneo tiene totalRounds fijo (competencias: = cantidad de temas), las
  //      jornadas NO cambian al agregar gente; solo cambia quién enfrenta a quién.
  t.participants = [...t.participants, ...toAdd];
  rebuildRounds(t, t.totalRounds);

  // 4) Buffet: asegurar que cada nuevo participante tenga al menos un tema (por defecto, el primero).
  if (t.contentType === 'buffet') {
    if (!t.participantTemas) t.participantTemas = {};
    const firstTema = t.buffetData?.Temas?.[0]?.Tema;
    toAdd.forEach(p => {
      if (!t.participantTemas[p] || !t.participantTemas[p].length) {
        t.participantTemas[p] = firstTema !== undefined ? [firstTema] : [];
      }
    });
  }

  // 5) Contenido individual: dejar el arreglo listo (vacío) para cargarlo después.
  if (t.contentType === 'individual') {
    if (!t.participantContent) t.participantContent = {};
    toAdd.forEach(p => { if (!t.participantContent[p]) t.participantContent[p] = []; });
  }

  // 6) Shared: si crecieron las jornadas, completar el contenido de las nuevas.
  //    Modo "temas por jornada" (JSON tipo buffet, sueltos): las jornadas nuevas
  //    quedan sin temas asignados (quedarán bloqueadas para evaluar hasta que se
  //    les asignen). Modo manual legado: se completa con el banco plano legado.
  if (t.contentType === 'shared') {
    if (t.buffetData && t.roundTemas) {
      t.roundTemas = ensureRoundTemas(t);
      t.roundQuestionsPerTema = ensureRoundQuestionsPerTema(t);
    } else {
      t.questionsByRound = ensureQuestionsByRound(t);
    }
  }

  return { added: toAdd };
}

// Fija la cantidad de jornadas de un torneo (en competencias = cantidad de temas) y
// regenera el calendario en bucle si hace falta. No guarda: llamar a saveTournament(t).
export function setTotalRounds(t, total) {
  if (!Number.isInteger(total) || total < 1) return;
  t.totalRounds = total;
  if ((t.rounds || []).length !== total) rebuildRounds(t, total);
}

// ---------- Reasignar rivales dentro de una misma jornada ----------

const SIDE_SCORE = { home: 'homeScore', away: 'awayScore' };
const SIDE_EXTRA = { home: 'extraHome', away: 'extraAway' };
const SIDE_Q     = { home: 'homeQ',     away: 'awayQ' };
const SIDE_C     = { home: 'homeC',     away: 'awayC' };

// Lee si un lado está marcado como ausente en un `result`, soportando el
// formato nuevo (`absent: {home, away}`) y el viejo (`absentSide`: string).
function readAbsentFlag(r, side) {
  if (!r) return false;
  if (r.absent && typeof r.absent === 'object') return !!r.absent[side];
  return r.absentSide === side;
}

// Extrae únicamente los datos que le pertenecen a UN lado (home o away) de un
// enfrentamiento: su puntaje, sus aciertos, y su progreso a medias si lo hay.
function extractSideData(m, side) {
  const r = m.result, p = m.progress;
  return {
    result: r ? {
      score: r[SIDE_SCORE[side]] || 0,
      extra: r[SIDE_EXTRA[side]] || 0,
      absent: readAbsentFlag(r, side),
      answers: (r.questionScores || []).map(qs => ({
        q: qs[SIDE_Q[side]] ?? null,
        c: qs[SIDE_C[side]] ?? null
      }))
    } : null,
    progress: p ? {
      extra: p.extraScores ? (p.extraScores[side] || 0) : 0,
      turns: (p.turnData || []).map(td => td[side] || null)
    } : null
  };
}

// Inyecta los datos extraídos con extractSideData() en el lado indicado de
// otro enfrentamiento (o del mismo), sin tocar el lado contrario.
function applySideData(m, side, data) {
  if (data.result) {
    if (!m.result) {
      m.result = { homeScore: 0, awayScore: 0, extraHome: 0, extraAway: 0, absent: { home: false, away: false }, questionScores: [] };
    }
    if (!m.result.absent || typeof m.result.absent !== 'object') {
      m.result.absent = { home: m.result.absentSide === 'home', away: m.result.absentSide === 'away' };
      delete m.result.absentSide;
    }
    m.result[SIDE_SCORE[side]] = data.result.score || 0;
    m.result[SIDE_EXTRA[side]] = data.result.extra || 0;
    m.result.absent[side] = !!data.result.absent;
    if (!m.result.questionScores) m.result.questionScores = [];
    data.result.answers.forEach((ans, i) => {
      if (!m.result.questionScores[i]) m.result.questionScores[i] = {};
      m.result.questionScores[i][SIDE_Q[side]] = ans.q;
      m.result.questionScores[i][SIDE_C[side]] = ans.c;
    });
  } else if (m.result) {
    m.result[SIDE_SCORE[side]] = 0;
    m.result[SIDE_EXTRA[side]] = 0;
    if (!m.result.absent || typeof m.result.absent !== 'object') {
      m.result.absent = { home: m.result.absentSide === 'home', away: m.result.absentSide === 'away' };
      delete m.result.absentSide;
    }
    m.result.absent[side] = false;
    (m.result.questionScores || []).forEach(qs => { qs[SIDE_Q[side]] = null; qs[SIDE_C[side]] = null; });
  }

  if (data.progress) {
    if (!m.progress) m.progress = { turnData: [], extraScores: { home: 0, away: 0 } };
    if (!m.progress.extraScores) m.progress.extraScores = { home: 0, away: 0 };
    m.progress.extraScores[side] = data.progress.extra || 0;
    if (!m.progress.turnData) m.progress.turnData = [];
    data.progress.turns.forEach((turn, i) => {
      if (!m.progress.turnData[i]) m.progress.turnData[i] = {};
      m.progress.turnData[i][side] = turn;
    });
  } else if (m.progress) {
    if (m.progress.extraScores) m.progress.extraScores[side] = 0;
    (m.progress.turnData || []).forEach(td => { td[side] = null; });
  }
}

/**
 * Cambia de rival a un participante DENTRO de la misma jornada, intercambiando
 * su lugar con otro participante que también juega esa jornada (en otro
 * enfrentamiento, o en el lado contrario del mismo). Cada uno se lleva
 * consigo sus propios aciertos y puntaje ya cargados —si los tenía—; lo único
 * que cambia es contra quién quedó enfrentado. La victoria de cada
 * enfrentamiento se recalcula sola a partir de los puntajes ya guardados,
 * ahora comparados entre quienes terminan cara a cara.
 *
 * sideA/sideB: 'home' | 'away'.
 * Devuelve true si el cambio se pudo aplicar.
 */
export function swapOpponentsInRound(t, roundIndex, matchIndexA, sideA, matchIndexB, sideB) {
  const round = t.rounds?.[roundIndex];
  if (!round) return false;
  const mA = round[matchIndexA], mB = round[matchIndexB];
  if (!mA || !mB) return false;

  const nameA = mA[sideA], nameB = mB[sideB];
  if (!nameA || !nameB || nameA === nameB) return false;

  const dataA = extractSideData(mA, sideA);
  const dataB = extractSideData(mB, sideB);

  mA[sideA] = nameB;
  mB[sideB] = nameA;

  applySideData(mA, sideA, dataB);
  applySideData(mB, sideB, dataA);

  return true;
}

// ---------- Shared ("mismo para todos") por jornada ----------

/**
 * Devuelve las preguntas asignadas a una jornada específica (índice 0-based)
 * cuando el torneo usa contentType 'shared'.
 *
 * Si el torneo tiene `questionsByRound` (consola por jornada), busca la ronda
 * correspondiente. Si no la encuentra, o si el torneo es de un formato anterior
 * que solo tenía un banco plano `questions`, devuelve ese banco como fallback
 * (comportamiento legado: mismas preguntas en todas las jornadas).
 */
// Preguntas de repaso: de la jornada 2 en adelante, el modo "temas por jornada" suma
// EXTRAS_REPASO preguntas extra tomadas de los temas de las jornadas anteriores.
export const EXTRAS_REPASO = 3;

// Preguntas propias (sin extras) de una jornada en modo "temas por jornada".
function temasQuestionsOfRound(t, roundIndex) {
  const asignados = t.roundTemas[roundIndex + 1] || [];
  const limit = t.roundQuestionsPerTema?.[roundIndex + 1];
  const qs = [];
  asignados.forEach(temaId => {
    const TemaObj = t.buffetData.Temas.find(x => String(x.Tema) === String(temaId));
    let preguntas = (TemaObj?.preguntas || []).map(p => ({
      pregunta: p.pregunta || '',
      respuesta: p.respuesta || '',
      justificacion: p.justificacion || ''
    }));
    if ([1, 2, 3].includes(limit)) preguntas = preguntas.slice(0, limit);
    preguntas.forEach(p => qs.push(p));
  });
  return qs;
}

// Generador con semilla (mulberry32) y hash de texto: las extras de una jornada son
// siempre las mismas (el modal se re-renderiza muchas veces y no pueden cambiar).
function seededRng(seedText) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Las EXTRAS_REPASO preguntas extra de una jornada (índice 0-based; [] en la jornada 1).
// Se reparten entre las jornadas anteriores, de la más reciente a la más antigua.
export function repasoQuestionsForRound(t, roundIndex) {
  if (!(t.buffetData && t.roundTemas) || roundIndex < 1) return [];
  const rnd = seededRng(`${t.id}:${roundIndex + 1}`);
  const barajar = arr => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  // No repetir lo que la jornada ya pregunta (p. ej. sin asignaciones todas las jornadas comparten temas).
  const vistos = new Set(temasQuestionsOfRound(t, roundIndex).map(q => `${q.pregunta}\u241f${q.respuesta}`));
  const colas = [];
  for (let r = roundIndex - 1; r >= 0; r--) {
    const propias = temasQuestionsOfRound(t, r).filter(q => {
      const k = `${q.pregunta}\u241f${q.respuesta}`;
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });
    if (propias.length) colas.push(barajar(propias).map(q => ({ ...q, extra: true, jornadaOrigen: r + 1 })));
  }
  const elegidas = [];
  while (elegidas.length < EXTRAS_REPASO && colas.some(c => c.length)) {
    for (const c of colas) {
      if (elegidas.length >= EXTRAS_REPASO) break;
      if (c.length) elegidas.push(c.shift());
    }
  }
  return elegidas;
}

export function sharedQuestionsForRound(t, roundIndex) {
  // Modo "temas": JSON con el mismo formato del buffet ({ Temas: [{ Tema, preguntas }] })
  // pero asignado por JORNADA en vez de por participante (t.roundTemas). Los temas quedan
  // "sueltos": no se ligan a ningún nombre, todos los participantes de esa jornada usan
  // exactamente las mismas preguntas. De la jornada 2 en adelante se suman 3 preguntas
  // extra de repaso sobre las jornadas anteriores (solo si la jornada ya tiene contenido,
  // para no habilitar una jornada sin temas solo por las extras).
  if (t.buffetData && t.roundTemas) {
    const qs = temasQuestionsOfRound(t, roundIndex);
    if (qs.length) repasoQuestionsForRound(t, roundIndex).forEach(p => qs.push(p));
    return qs;
  }
  // Modo manual (legado): consola de preguntas sueltas por jornada.
  if (t.questionsByRound && t.questionsByRound.length) {
    const entry = t.questionsByRound.find(r => r.round === roundIndex + 1);
    if (entry) return (entry.questions || []).map(q => ({
      pregunta: q.pregunta || q.text || '',
      respuesta: q.respuesta || '',
      justificacion: q.justificacion || ''
    }));
  }
  // Fallback legado: banco plano único para todas las jornadas.
  return (t.questions || []).map(q => ({
    pregunta: q.pregunta || q.text || '',
    respuesta: q.respuesta || '',
    justificacion: q.justificacion || ''
  }));
}

/**
 * Devuelve los Temas (sueltos, sin ligarse a participantes) asignados a una
 * jornada específica cuando el torneo usa contenido "mismo para todos" con
 * JSON de temas (t.buffetData + t.roundTemas).
 */
export function sharedTemasForRound(t, roundIndex) {
  return (t.roundTemas && t.roundTemas[roundIndex + 1]) || [];
}

/**
 * Indica si una jornada tiene contenido asignado y por lo tanto se puede
 * evaluar. Para torneos "buffet" siempre es true (el contenido se garantiza
 * por participante al crear/agregar). Para torneos "mismo para todos" con
 * JSON de temas, exige que se hayan elegido temas para esa jornada. Para el
 * modo manual legado, exige que existan preguntas cargadas.
 */
export function roundReadyForEval(t, roundIndex) {
  if (t.contentType === 'buffet') return true;
  return sharedQuestionsForRound(t, roundIndex).length > 0;
}

/**
 * Construye una copia editable de `questionsByRound` con una entrada por cada
 * jornada del torneo (t.rounds). Si falta contenido específico para alguna
 * jornada, la rellena con el banco plano legado `t.questions` (si existe),
 * para no perder datos de torneos creados antes de este cambio.
 */
export function ensureQuestionsByRound(t) {
  const existing = t.questionsByRound || [];
  return t.rounds.map((_, i) => {
    const found = existing.find(r => r.round === i + 1);
    return {
      round: i + 1,
      questions: found ? [...found.questions] : [...(t.questions || [])]
    };
  });
}

/**
 * Igual que ensureQuestionsByRound pero para el modo "temas por jornada"
 * (t.roundTemas). Conserva la asignación de las jornadas existentes y deja
 * vacía la de las jornadas nuevas (no se puede "adivinar" qué temas les
 * corresponden, ya que están sueltos y no ligados a participantes) — por
 * eso esas jornadas nuevas quedan bloqueadas para evaluar hasta que alguien
 * les asigne temas manualmente.
 */
export function ensureRoundTemas(t) {
  const existing = t.roundTemas || {};
  const result = {};
  t.rounds.forEach((_, i) => {
    result[i + 1] = existing[i + 1] ? [...existing[i + 1]] : [];
  });
  return result;
}

/**
 * Igual que ensureRoundTemas pero para la cantidad de preguntas por tema que
 * se toman en cada jornada (t.roundQuestionsPerTema). Cada jornada guarda un
 * número (1, 2 o 3) o `null`, que significa "todas las preguntas del tema".
 * Conserva la configuración de las jornadas existentes; las nuevas quedan en
 * `null` (todas) por defecto.
 */
export function ensureRoundQuestionsPerTema(t) {
  const existing = t.roundQuestionsPerTema || {};
  const result = {};
  t.rounds.forEach((_, i) => {
    const v = existing[i + 1];
    result[i + 1] = [1, 2, 3].includes(v) ? v : null;
  });
  return result;
}

// ---------- Buffet helpers ----------

/**
 * Shuffle Fisher-Yates (copia, no muta).
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Recolecta el texto de las preguntas que ya le salieron a un participante
 * en CUALQUIER otro enfrentamiento del torneo (jornadas ya evaluadas o
 * dejadas a medias con progreso guardado). Se usa para no repetirle
 * preguntas de un tema si todavía hay otras sin usar.
 */
function askedQuestionTexts(t, participantName) {
  const asked = new Set();
  (t.rounds || []).forEach(round => {
    (round || []).forEach(m => {
      if (m.home !== participantName && m.away !== participantName) return;
      const side = m.home === participantName ? 'home' : 'away';

      // Enfrentamiento ya evaluado y guardado.
      (m.result?.questionScores || []).forEach(s => {
        const q = side === 'home' ? s.homeQ : s.awayQ;
        if (q?.pregunta) asked.add(q.pregunta);
      });

      // Enfrentamiento a medias (progreso autoguardado).
      (m.progress?.turnData || []).forEach(td => {
        const q = td?.[side]?.question;
        if (q?.pregunta) asked.add(q.pregunta);
      });
    });
  });
  return asked;
}

/**
 * Devuelve los temas asignados al participante agrupados con N preguntas aleatorias cada uno,
 * donde N es `t.questionsPerTema` (1, 2 o 3 — por defecto 3 si el torneo no lo define).
 * Formato: [{ Tema: number|string, questions: [{ pregunta, respuesta, justificacion }] }]
 *
 * Ejemplo: si tiene asignados temas 1, 2, 3 y questionsPerTema = 2 → devuelve 3 grupos,
 * cada uno con hasta 2 preguntas aleatorias de ese tema.
 *
 * Prioriza preguntas que el participante todavía no respondió en jornadas
 * anteriores del torneo: primero arma el grupo al azar entre las preguntas
 * "nuevas" de ese tema, y solo si no alcanzan para completar la cantidad
 * pedida, rellena con preguntas ya usadas (también elegidas al azar) para
 * no dejar el tema corto.
 */
export function buffetTemasForParticipant(t, participantName) {
  const Temas = (t.participantTemas && t.participantTemas[participantName]) || [];
  const bd = t.buffetData;
  if (!bd || !bd.Temas) return [];
  const perTema = [1, 2, 3].includes(t.questionsPerTema) ? t.questionsPerTema : 3;
  const asked = askedQuestionTexts(t, participantName);
  const result = [];
  Temas.forEach(d => {
    const TemaObj = bd.Temas.find(x => String(x.Tema) === String(d));
    if (!TemaObj) return;
    const allQ = (TemaObj.preguntas || []).map(p => ({
      pregunta: p.pregunta || '',
      respuesta: p.respuesta || '',
      justificacion: p.justificacion || ''
    }));
    const nuevas = allQ.filter(q => !asked.has(q.pregunta));
    const yaUsadas = allQ.filter(q => asked.has(q.pregunta));

    let picked = shuffle(nuevas).slice(0, perTema);
    if (picked.length < perTema) {
      picked = picked.concat(shuffle(yaUsadas).slice(0, perTema - picked.length));
    }
    result.push({ Tema: d, questions: shuffle(picked) });
  });
  return result;
}

/**
 * Compatibilidad: devuelve [{ text }] plano aplanando los temas.
 * N temas × questionsPerTema preguntas = total de items.
 */
export function buffetItemsForParticipant(t, participantName) {
  const grouped = buffetTemasForParticipant(t, participantName);
  const items = [];
  grouped.forEach(g => g.questions.forEach(q => items.push(q)));
  return items;
}

// ---------- Marcador parcial de un enfrentamiento en curso ----------

/**
 * Marcador parcial de un enfrentamiento que quedó a medias (progreso
 * autoguardado, sin terminar ni guardar como resultado final). Suma las
 * preguntas ya evaluadas correctas + los puntos de ronda extra ya asignados,
 * igual que el resultado final, para poder mostrar "cómo va" en vivo tanto
 * en la jornada como en la tabla de posiciones. Devuelve `null` si todavía
 * no hay nada evaluado (para no mostrar 0-0 sin sentido).
 */
export function partialScore(m) {
  const p = m.progress;
  if (!p) return null;
  let home = 0, away = 0, answered = 0;
  (p.turnData || []).forEach(td => {
    if (td.home?.correct === true) { home++; answered++; }
    else if (td.home?.correct === false) answered++;
    if (td.away?.correct === true) { away++; answered++; }
    else if (td.away?.correct === false) answered++;
  });
  if (p.extraScores) {
    home += p.extraScores.home || 0;
    away += p.extraScores.away || 0;
  }
  if (answered === 0 && !(p.extraScores && ((p.extraScores.home || 0) + (p.extraScores.away || 0) > 0))) return null;
  return { home, away };
}

// ---------- Puntajes con decimales (enfrentamiento por JSON importado) ----------

/**
 * Redondea un puntaje a 1 decimal evitando errores de punto flotante
 * (0.8 + 1.3 + 0.8 = 2.9000000000000004, por ejemplo).
 */
export function roundScore(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * Formatea un puntaje para mostrarlo: sin decimales si es entero (3, no 3.0),
 * con 1 decimal si no lo es (1.3, 0.8).
 */
export function fmtScore(n) {
  const r = roundScore(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// ============================================================
//  Sincronización con el Worker (API) — los torneos YA NO se crean aquí
// ============================================================
// Los torneos (competencias) se crean en el worker. Esta app solo los
// importa (participantes inscritos, temas, preguntas, bonus) y los gestiona:
// jornadas, enfrentamientos, resultados, bonus y certificados. Esos datos de
// gestión viven en este navegador y NO se pisan al volver a sincronizar.

export const API_URL = 'https://api-worker.daniel-albarracin300.workers.dev';

async function apiQuery(sql, params = []) {
  const res = await fetch(`${API_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params })
  });
  let data = {};
  try { data = await res.json(); } catch { /* respuesta sin JSON */ }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data.results || [];
}

/**
 * Respuestas de UN participante en UNA jornada de una competencia, leidas de
 * la base de datos (intentos_cuestionario.competencia_id + .jornada, que guarda
 * el worker al registrar cada intento). Si respondio varios temas en esa jornada
 * se juntan todas sus respuestas. Si repitio un tema se usa su PRIMER intento
 * oficial (no simulacro).
 * Devuelve { respuestas: [{ pregunta, tiempo_respuesta, es_correcta }], temas, fecha }
 * con el mismo formato que usaba el JSON importado.
 */
export async function fetchRespuestasJornada(competenciaId, codigo, jornada) {
  const rows = await apiQuery(
    `SELECT rp.pregunta_texto AS pregunta, rp.tiempo_respuesta, rp.es_correcta,
            c.nombre AS tema, ic.fecha
       FROM intentos_cuestionario ic
       JOIN respuestas_preguntas rp ON rp.intento_id = ic.id
       JOIN cuestionarios c ON c.id = ic.cuestionario_id
      WHERE ic.id IN (
              SELECT MIN(id) FROM intentos_cuestionario
               WHERE competencia_id = ? AND participante_codigo = ? AND jornada = ? AND es_simulacro = 0
               GROUP BY cuestionario_id)
      ORDER BY ic.id, rp.id`,
    [competenciaId, codigo, jornada]
  );
  return {
    respuestas: rows.map(r => ({
      pregunta: r.pregunta,
      tiempo_respuesta: Number(r.tiempo_respuesta) || 0,
      es_correcta: Number(r.es_correcta) === 1
    })),
    temas: [...new Set(rows.map(r => r.tema))],
    fecha: rows.length ? rows[0].fecha : null
  };
}

// Quita caracteres que romperían atributos HTML (los nombres de tema se usan como id).
const cleanLabel = s => String(s ?? '').replace(/["'<>&`]/g, '').replace(/\s+/g, ' ').trim();

function parseArr(txt) {
  if (txt === null || txt === undefined || txt === '') return [];
  try { const v = JSON.parse(txt); return Array.isArray(v) ? v : [v]; } catch { return [txt]; }
}

function toAppQuestion(p) {
  const correctas = parseArr(p.respuesta_correcta).map(String);
  return {
    pregunta: p.pregunta || '',
    respuesta: p.tipo === 'texto' ? (correctas[0] || '') : correctas.join(', '),
    justificacion: p.justificacion || ''
  };
}

/**
 * Descarga las competencias del worker y las convierte al formato de torneo
 * de la app. Si el torneo ya existía localmente conserva todos los resultados:
 * solo agrega inscritos nuevos y refresca contenido (temas/preguntas/bonus).
 * Devuelve { imported, updated, skipped: [{titulo, motivo}], newParticipants }.
 */
export async function syncFromApi() {
  // Un GET a /cuestionarios hace que el worker cree/actualice su esquema de torneo.
  await fetch(`${API_URL}/cuestionarios`).catch(() => {});

  const [comps, inscritos, temasRows, jorTemas, partTemas, bonusRows, orgRows] = await Promise.all([
    apiQuery(`SELECT id, titulo, tipo_contenido, modo_contenido, preguntas_por_tema, ocultar_resultados FROM competencias ORDER BY id`),
    apiQuery(`SELECT ci.competencia_id, ci.participante_codigo AS codigo, p.nombre, p.club_id, p.iglesia_id
              FROM competencia_inscripciones ci JOIN participantes p ON p.codigo = ci.participante_codigo
              ORDER BY ci.competencia_id, ci.id`),
    apiQuery(`SELECT c.id, c.competencia_id, c.nombre, pr.tipo, pr.pregunta, pr.respuesta_correcta, pr.justificacion
              FROM cuestionarios c LEFT JOIN preguntas pr ON pr.cuestionario_id = c.id
              WHERE c.competencia_id IS NOT NULL
              ORDER BY c.competencia_id, c.id, COALESCE(pr.orden, pr.id), pr.id`),
    apiQuery(`SELECT competencia_id, jornada, cuestionario_id FROM competencia_jornada_temas ORDER BY competencia_id, jornada, cuestionario_id`),
    apiQuery(`SELECT competencia_id, participante_codigo AS codigo, cuestionario_id FROM competencia_participante_temas ORDER BY competencia_id`),
    apiQuery(`SELECT competencia_id, participante_codigo AS codigo, puntos FROM competencia_bonus`),
    // Nombres de clubes e iglesias (para la clasificación por equipos). Si la vista no existe, se usan los ids.
    apiQuery(`SELECT tipo, ref_id, organizacion, detalle FROM vista_organizaciones WHERE tipo IN ('club','iglesia')`).catch(() => [])
  ]);

  // "club:3" -> nombre del club; "iglesia:2" -> "Iglesia (Denominación)".
  const teamNames = new Map(orgRows.map(o => [
    `${o.tipo}:${o.ref_id}`,
    o.tipo === 'iglesia' ? `${o.detalle || o.organizacion}${o.detalle && o.organizacion ? ` (${o.organizacion})` : ''}` : o.organizacion
  ]));
  const teamLabel = (tipo, id) => id ? (teamNames.get(`${tipo}:${id}`) || `${tipo === 'club' ? 'Club' : 'Iglesia'} ${id}`) : null;

  const by = (rows, key) => {
    const m = new Map();
    rows.forEach(r => { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); });
    return m;
  };
  const inscByComp = by(inscritos, 'competencia_id');
  const temasByComp = by(temasRows, 'competencia_id');
  const jorByComp = by(jorTemas, 'competencia_id');
  const ptByComp = by(partTemas, 'competencia_id');
  const bonusByComp = by(bonusRows, 'competencia_id');

  const all = loadAll();
  const report = { imported: 0, updated: 0, skipped: [], newParticipants: 0 };

  for (const c of comps) {
    // ----- Temas (cuestionarios) con sus preguntas -----
    const temaMap = new Map(); // cuestionario_id -> { Tema, preguntas }
    const usedLabels = new Set();
    (temasByComp.get(c.id) || []).forEach(r => {
      if (!temaMap.has(r.id)) {
        let label = cleanLabel(r.nombre) || `Tema ${r.id}`;
        if (usedLabels.has(label)) label = `${label} (${r.id})`;
        usedLabels.add(label);
        temaMap.set(r.id, { Tema: label, preguntas: [] });
      }
      if (r.pregunta) temaMap.get(r.id).preguntas.push(toAppQuestion(r));
    });
    const temasConPreguntas = [...temaMap.entries()].filter(([, v]) => v.preguntas.length);
    // Solo "mismo para todos" + "temas asignados a jornadas": jornadas = cantidad de temas.
    const jornadasPorTemas = c.tipo_contenido !== 'buffet' && c.modo_contenido === 'temas';
    const labelOf = id => temaMap.get(id)?.Tema;

    // ----- Inscritos -----
    const insc = inscByComp.get(c.id) || [];
    const tid = 'cmp_' + c.id;
    let t = all.find(x => x.id === tid) || null;

    if (insc.length < 2 && !t) { report.skipped.push({ titulo: c.titulo, motivo: 'menos de 2 inscritos' }); continue; }
    if (!temasConPreguntas.length && !t) { report.skipped.push({ titulo: c.titulo, motivo: 'sin temas con preguntas' }); continue; }

    // Nombre visible de cada código (estable: si ya existía localmente se respeta).
    const codeToName = new Map();
    const takenNames = new Set(t ? t.participants : []);
    const knownCodes = t?.apiCodes || {};
    const reverseKnown = new Map(Object.entries(knownCodes).map(([n, cod]) => [cod, n]));
    insc.forEach(i => {
      if (reverseKnown.has(i.codigo)) { codeToName.set(i.codigo, reverseKnown.get(i.codigo)); return; }
      let name = String(i.nombre || i.codigo).trim();
      if (takenNames.has(name)) name = `${name} (${i.codigo})`;
      takenNames.add(name);
      codeToName.set(i.codigo, name);
    });
    const apiNames = insc.map(i => codeToName.get(i.codigo));

    const isNew = !t;
    if (isNew) {
      const rounds = generateRounds(apiNames, jornadasPorTemas ? temasConPreguntas.length || undefined : undefined);
      t = {
        id: tid, name: c.titulo, participants: [...apiNames],
        contentType: c.tipo_contenido === 'buffet' ? 'buffet' : 'shared',
        questions: [], questionsByRound: [], participantContent: {},
        buffetData: null, roundTemas: null, participantTemas: {},
        questionsPerTema: 3, rounds, hideResults: !!c.ocultar_resultados,
        createdAt: Date.now(), totalRounds: jornadasPorTemas ? temasConPreguntas.length || undefined : undefined
      };
      all.push(t);
      report.imported++;
    } else {
      // Jornadas = cantidad de temas (se fija antes de sumar gente para que no cambien por los inscritos).
      const teniaFijo = t.totalRounds !== undefined;
      if (jornadasPorTemas && temasConPreguntas.length) t.totalRounds = temasConPreguntas.length;
      else delete t.totalRounds; // depende de los inscritos
      const nuevos = apiNames.filter(n => !t.participants.includes(n));
      if (nuevos.length) { addParticipants(t, nuevos); report.newParticipants += nuevos.length; }
      if (jornadasPorTemas && temasConPreguntas.length) setTotalRounds(t, temasConPreguntas.length);
      else if (teniaFijo) rebuildRounds(t, undefined); // dejó de ser shared+temas: vuelve al ciclo completo, conservando lo jugado
      t.name = c.titulo;
      report.updated++;
    }

    t.competenciaId = c.id;
    t.apiCodes = { ...(t.apiCodes || {}), ...Object.fromEntries([...codeToName].map(([cod, n]) => [n, cod])) };
    // Club e iglesia de cada inscrito (se refrescan en cada sincronización): sirven para la clasificación por equipos.
    t.apiTeams = t.apiTeams || {};
    insc.forEach(i => {
      const n = codeToName.get(i.codigo);
      if (n) t.apiTeams[n] = { club: teamLabel('club', i.club_id), iglesia: teamLabel('iglesia', i.iglesia_id) };
    });
    t.contentType = c.tipo_contenido === 'buffet' ? 'buffet' : 'shared';
    if (isNew) t.hideResults = !!c.ocultar_resultados;

    // ----- Contenido -----
    t.buffetData = { Temas: temasConPreguntas.map(([, v]) => ({ Tema: v.Tema, preguntas: v.preguntas })) };

    if (t.contentType === 'buffet') {
      const qpt = Number(c.preguntas_por_tema);
      t.questionsPerTema = [1, 2, 3].includes(qpt) ? qpt : 3;
      t.roundTemas = null;
      t.questionsByRound = [];
      const asign = {};
      (ptByComp.get(c.id) || []).forEach(r => {
        const n = codeToName.get(r.codigo), lab = labelOf(r.cuestionario_id);
        if (!n || !lab || !t.buffetData.Temas.some(x => x.Tema === lab)) return;
        (asign[n] = asign[n] || []).push(lab);
      });
      t.participantTemas = t.participantTemas || {};
      t.participants.forEach(p => {
        if (asign[p]) t.participantTemas[p] = asign[p];
        else if (apiNames.includes(p)) t.participantTemas[p] = []; // el worker no le asignó temas
        else t.participantTemas[p] = t.participantTemas[p] || [];  // participante solo local: se conserva
      });
    } else {
      // shared: temas por jornada (misma regla del worker: sin asignaciones => todos los temas en todas las jornadas)
      t.participantTemas = {};
      t.questionsByRound = [];
      const all_labels = t.buffetData.Temas.map(x => x.Tema);
      const porJornada = {};
      (jorByComp.get(c.id) || []).forEach(r => {
        const lab = labelOf(r.cuestionario_id);
        if (!lab || !all_labels.includes(lab)) return;
        (porJornada[r.jornada] = porJornada[r.jornada] || []).push(lab);
      });
      const hayAsignaciones = Object.keys(porJornada).length > 0;
      t.roundTemas = {};
      t.rounds.forEach((_, i) => {
        t.roundTemas[i + 1] = hayAsignaciones ? (porJornada[i + 1] || []) : [...all_labels];
      });
      t.roundQuestionsPerTema = ensureRoundQuestionsPerTema(t);
    }

    // ----- Bonus: se completa con lo del worker solo donde no hay valor local -----
    t.bonusPoints = t.bonusPoints || {};
    (bonusByComp.get(c.id) || []).forEach(b => {
      const n = codeToName.get(b.codigo);
      if (n && t.bonusPoints[n] === undefined && b.puntos) t.bonusPoints[n] = b.puntos;
    });
  }

  saveAll(all);
  return report;
}

// ---------- Utilidad HTML ----------
export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}