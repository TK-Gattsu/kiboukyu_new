// 開発用: Google Apps Script のサービスをブラウザ上で模擬する（本番では使わない）
// データはこのブラウザの localStorage（gasmock_ で始まるキー）に入る
(function () {
  const P = 'gasmock_';
  const load = (k, d) => { try { const v = localStorage.getItem(P + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = (k, v) => localStorage.setItem(P + k, JSON.stringify(v));

  // ---- PropertiesService ----
  window.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: k => load('prop_' + k, null),
      setProperty: (k, v) => save('prop_' + k, String(v)),
    }),
  };

  // ---- SpreadsheetApp（シートは2次元配列で保存）----
  const db = () => load('db', {});
  const saveDb = d => save('db', d);
  function makeSheet(ssId, name) {
    const get = () => db()[ssId].sheets[name];
    const put = rows => { const d = db(); d[ssId].sheets[name] = rows; saveDb(d); };
    return {
      getName: () => name,
      getLastRow: () => get().length,
      getMaxRows: () => Math.max(1000, get().length),
      getDataRange: () => ({
        getValues: () => {
          const rows = get();
          const w = Math.max(1, ...rows.map(r => r.length));
          return rows.length ? rows.map(r => Array.from({ length: w }, (_, j) => r[j] === undefined || r[j] === null ? '' : r[j])) : [['']];
        },
      }),
      getRange: (row, col, nr, nc) => {
        nr = nr || 1; nc = nc || 1;
        const rg = {
          setNumberFormat: () => rg,
          setValues: vals => {
            const rows = get();
            for (let i = 0; i < nr; i++) {
              while (rows.length < row + i) rows.push([]);
              const line = rows[row - 1 + i];
              for (let j = 0; j < nc; j++) line[col - 1 + j] = vals[i][j];
            }
            put(rows);
            return rg;
          },
          setValue: v => rg.setValues([[v]]),
          getValues: () => {
            const rows = get();
            return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
              const r = rows[row - 1 + i]; const v = r ? r[col - 1 + j] : '';
              return v === undefined || v === null ? '' : v;
            }));
          },
        };
        return rg;
      },
      appendRow: vals => { const rows = get(); rows.push(vals.slice()); put(rows); },
      deleteRows: (row, n) => { const rows = get(); rows.splice(row - 1, n); put(rows); },
    };
  }
  function spreadsheet(id) {
    return {
      getId: () => id,
      getName: () => db()[id].name,
      getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id,
      copy: name => { const d = db(); const nid = 'ss' + Date.now() + 'c'; d[nid] = { name: name, sheets: JSON.parse(JSON.stringify(d[id].sheets)) }; saveDb(d); return spreadsheet(nid); },
      getSheetByName: n => (db()[id].sheets[n] ? makeSheet(id, n) : null),
      insertSheet: n => { const d = db(); d[id].sheets[n] = []; saveDb(d); return makeSheet(id, n); },
    };
  }
  window.SpreadsheetApp = {
    create: name => { const d = db(); const id = 'ss' + Date.now(); d[id] = { name: name, sheets: {} }; saveDb(d); return spreadsheet(id); },
    openById: id => { if (!db()[id]) throw new Error('Spreadsheet not found'); return spreadsheet(id); },
  };

  // ---- CacheService（有効期限つき）----
  window.CacheService = {
    getScriptCache: () => ({
      get: k => { const c = load('cache', {}); const e = c[k]; return e && e.exp > Date.now() ? e.v : null; },
      put: (k, v, sec) => { const c = load('cache', {}); c[k] = { v: String(v), exp: Date.now() + (sec || 600) * 1000 }; save('cache', c); },
      remove: k => { const c = load('cache', {}); delete c[k]; save('cache', c); },
    }),
  };
  window.LockService = { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
  window.Logger = { log: (...a) => console.log('[Logger]', ...a) };

  // ---- Utilities（SHA-256 は同期で計算）----
  const primes = []; for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
  const frac32 = x => Math.floor((x - Math.floor(x)) * 4294967296) >>> 0;
  const K = primes.map(p => frac32(Math.cbrt(p)));
  const H0 = primes.slice(0, 8).map(p => frac32(Math.sqrt(p)));
  const ror = (x, n) => (x >>> n) | (x << (32 - n));
  function sha256(str) {
    const msg = new TextEncoder().encode(str);
    const len = msg.length;
    const buf = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    buf.set(msg); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(buf.length - 4, (len * 8) >>> 0);
    dv.setUint32(buf.length - 8, Math.floor(len * 8 / 4294967296));
    const H = H0.slice(); const W = new Uint32Array(64);
    for (let i = 0; i < buf.length; i += 64) {
      for (let t = 0; t < 16; t++) W[t] = dv.getUint32(i + t * 4);
      for (let t = 16; t < 64; t++) {
        const s0 = ror(W[t - 15], 7) ^ ror(W[t - 15], 18) ^ (W[t - 15] >>> 3);
        const s1 = ror(W[t - 2], 17) ^ ror(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, h].forEach((v, k) => { H[k] = (H[k] + v) >>> 0; });
    }
    const out = [];
    for (const x of H) out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
    return out.map(v => (v > 127 ? v - 256 : v));   // GASと同じく符号付きバイト
  }
  window.Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest: (alg, str) => sha256(String(str)),
    getUuid: () => crypto.randomUUID(),
  };
  window.__sha256 = sha256;   // 動作確認用

  // ---- google.script.run（引数・戻り値はJSONで受け渡し、_ で終わる関数は呼べない）----
  // 本物のGASと同じく、名前が「__」で終わる項目を含む引数・戻り値はエラーにする
  function checkKeys(v) {
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (/__$/.test(k)) throw new Error('User properties cannot end with "__". Failed on property: ' + k);
        checkKeys(v[k]);
      }
    }
  }
  function runner(ok, ng) {
    return new Proxy({}, {
      get(_, prop) {
        if (prop === 'withSuccessHandler') return f => runner(f, ng);
        if (prop === 'withFailureHandler') return f => runner(ok, f);
        return (...args) => setTimeout(() => {
          try {
            const fn = String(prop).endsWith('_') ? null : (window.__gas || {})[prop];
            if (typeof fn !== 'function') throw new Error('Script function not found: ' + String(prop));
            checkKeys(args);
            const res = fn(...JSON.parse(JSON.stringify(args)));
            checkKeys(res);
            if (ok) ok(res === undefined ? undefined : JSON.parse(JSON.stringify(res)));
          } catch (e) { if (ng) ng(e); else console.error(e); }
        }, 80);
      },
    });
  }
  window.google = { script: { get run() { return runner(null, null); } } };
  window.__gasMockReset = () => { Object.keys(localStorage).filter(k => k.startsWith(P)).forEach(k => localStorage.removeItem(k)); };
})();
