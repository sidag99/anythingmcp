/**
 * Everything that runs INSIDE the isolate: the bootstrap that builds the script's
 * world (`tools`, `util`, `args`, `console`) and the wrapper around user code.
 *
 * The isolate is a bare V8 context: no require, process, fs, fetch, timers or
 * Buffer exist in it. The bootstrap only adds what the script is meant to use and
 * removes the host bridge handles from the global object once captured.
 */

/** File name V8 reports for user code in syntax errors and stack frames. */
export const SCRIPT_FILE = 'sandbox.js';
export const RUNTIME_FILE = 'sandbox-runtime.js';

/** Lines the wrapper puts before the user's first line. */
export const WRAPPER_LINE_OFFSET = 2;

/**
 * Wrap user code so top-level `await` and `return` work. The user's code starts
 * on line WRAPPER_LINE_OFFSET + 1. The result is serialised and size-checked in
 * here (`__finish`), so an oversize payload never crosses the isolate boundary.
 */
export function wrapUserCode(code: string): string {
  return (
    '(async () => {\n' +
    'const __value = await (async () => {\n' +
    code +
    '\n})();\n' +
    'return __finish(__value);\n' +
    '})()'
  );
}

/**
 * Host globals expected before this runs (all removed again by the bootstrap):
 *   __call(name, argsJson) / __describe(name)  Reference -> Promise<envelope JSON>
 *   __log(line)                                 Reference, applySync
 *   __toolNamesJson, __argsJson                 JSON strings
 *   __maxOut, __maxLog                          numbers
 *
 * Bridge envelopes are `{"ok":true,"v":<json>}` or `{"ok":false,"code","message"}`;
 * host callbacks never reject, so a dying isolate cannot leave an unhandled
 * rejection on the host.
 *
 * No backticks or template placeholders in here: this is a plain string.
 */
export const RUNTIME_SOURCE = `
(function () {
  'use strict';
  var g = globalThis;
  var call = g.__call, describe = g.__describe, log = g.__log;
  var names = JSON.parse(g.__toolNamesJson);
  var argsJson = g.__argsJson;
  var maxOut = g.__maxOut, maxLog = g.__maxLog;
  var stringify = JSON.stringify, parse = JSON.parse, map = Array.prototype.map;
  var RES = { result: { promise: true } };

  delete g.__call; delete g.__describe; delete g.__log;
  delete g.__toolNamesJson; delete g.__argsJson; delete g.__maxOut; delete g.__maxLog;
  // Wasm memory lives outside the V8 heap cap and nothing here needs it.
  delete g.WebAssembly;

  function unwrap(raw) {
    var env = parse(raw);
    if (env.ok) return env.v;
    var e = new Error(env.code + ': ' + env.message);
    e.code = env.code;
    throw e;
  }

  var tools = new Proxy(Object.create(null), {
    get: function (_, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === 'list') return function () { return names.slice(); };
      if (name === 'describe') {
        return async function (n) { return unwrap(await describe.apply(undefined, [String(n)], RES)); };
      }
      return async function (a) {
        var json = stringify(a === undefined ? {} : a);
        return unwrap(await call.apply(undefined, [name, json === undefined ? '{}' : json], RES));
      };
    },
    has: function (_, name) { return names.indexOf(name) !== -1; },
    ownKeys: function () { return names.slice(); },
    getOwnPropertyDescriptor: function (_, name) {
      return names.indexOf(name) !== -1
        ? { value: undefined, enumerable: true, configurable: true }
        : undefined;
    }
  });

  var logged = 0;
  function fmt(x) {
    if (typeof x === 'string') return x;
    try { var s = stringify(x); return s === undefined ? String(x) : s; } catch (e) { return String(x); }
  }
  function write() {
    if (logged >= maxLog) return;
    logged++;
    var line = map.call(arguments, fmt).join(' ');
    if (line.length > 500) line = line.slice(0, 500);
    log.applySync(undefined, [line]);
  }
  var con = { log: write, info: write, warn: write, error: write, debug: write };

  // UTC throughout: local-time Date math shifts the day for zones ahead of UTC.
  function iso(d) { return d.toISOString().slice(0, 10); }
  function asDate(d) { return d === undefined ? new Date() : new Date(d); }
  var util = {
    daysAgo: function (n) { return iso(new Date(Date.now() - n * 864e5)); },
    startOfMonth: function (d) { var x = asDate(d); return iso(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1))); },
    endOfMonth: function (d) { var x = asDate(d); return iso(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0))); },
    groupBy: function (rows, keyFn) {
      var out = Object.create(null);
      for (var i = 0; i < rows.length; i++) {
        var k = keyFn(rows[i]);
        (out[k] || (out[k] = [])).push(rows[i]);
      }
      return out;
    },
    sum: function (rows, f) {
      var s = 0;
      for (var i = 0; i < rows.length; i++) s += Number(f ? f(rows[i]) : rows[i]) || 0;
      return s;
    }
  };

  Object.defineProperty(g, 'console', { value: con, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(g, '__finish', {
    enumerable: false,
    value: function (v) {
      var s;
      try { s = stringify(v === undefined ? null : v); }
      catch (e) { return { k: 'unserializable', m: String(e && e.message) }; }
      if (s === undefined) s = 'null';
      if (s.length > maxOut) return { k: 'toolarge', n: s.length };
      return { k: 'ok', j: s };
    }
  });
  g.tools = tools;
  g.util = util;
  g.args = parse(argsJson);
})();
`;
