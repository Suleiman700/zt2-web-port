// Disassembler for the game's compiled Lua 5.0 scripts (scripts/*.bin, scenario/scripts/*.bin),
// written from the Lua 5.0 bytecode format (lundump.c / lopcodes.h). Prints each function's
// constants and instructions with globals, constants and jumps resolved, to read game logic.
// Usage: node tools/luadis.mjs <path-in-archives | local file>
import { open, readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
process.removeAllListeners('warning');

const OPS = ['MOVE', 'LOADK', 'LOADBOOL', 'LOADNIL', 'GETUPVAL', 'GETGLOBAL', 'GETTABLE', 'SETGLOBAL', 'SETUPVAL', 'SETTABLE',
  'NEWTABLE', 'SELF', 'ADD', 'SUB', 'MUL', 'DIV', 'POW', 'UNM', 'NOT', 'CONCAT', 'JMP', 'EQ', 'LT', 'LE', 'TEST', 'CALL',
  'TAILCALL', 'RETURN', 'FORLOOP', 'TFORLOOP', 'TFORPREP', 'SETLIST', 'SETLISTO', 'CLOSE', 'CLOSURE'];
const MAXSTACK = 250;
const MAXARG_sBX = (1 << 17) - 1;

async function load(arg) {
  if (/^[a-z]:|^\.|^\//i.test(arg)) return new Uint8Array(await readFile(arg));
  const fs = new GameFS();
  for (const n of ['x300_000.z2f', 'x301_000.z2f', 'x302_000.z2f']) {
    const fh = await open(new URL(`../orgfiles/${n}`, import.meta.url)); const { size } = await fh.stat();
    fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
  }
  return fs.read(arg);
}

function parse(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x1b || bytes[1] !== 0x4c || bytes[4] !== 0x50) throw new Error('Not Lua 5.0 bytecode');
  // Header: signature (4), version, endianness, sizes of int, size_t, Instruction, OP, A, B, C bits,
  // lua_Number (10 bytes), then a test number (8).
  let p = 22;
  const int = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const byte = () => bytes[p++];
  const str = () => { const n = dv.getUint32(p, true); p += 4; if (!n) return null; const s = new TextDecoder('latin1').decode(bytes.subarray(p, p + n - 1)); p += n; return s; };
  const fn = () => {
    const f = { source: str(), line: int(), nups: byte(), params: byte(), vararg: byte(), stack: byte() };
    const nLines = int(); p += nLines * 4;
    const nLoc = int(); f.locals = []; for (let i = 0; i < nLoc; i++) f.locals.push({ name: str(), start: int(), end: int() });
    const nUp = int(); f.upvalues = []; for (let i = 0; i < nUp; i++) f.upvalues.push(str());
    const nK = int(); f.k = [];
    for (let i = 0; i < nK; i++) {
      const t = byte();
      if (t === 3) { f.k.push(dv.getFloat64(p, true)); p += 8; } else if (t === 4) f.k.push(str()); else f.k.push(null);
    }
    const nP = int(); f.protos = []; for (let i = 0; i < nP; i++) f.protos.push(fn());
    const nCode = int(); f.code = []; for (let i = 0; i < nCode; i++) f.code.push(dv.getUint32(p + i * 4, true)); p += nCode * 4;
    return f;
  };
  return fn();
}

const kstr = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

function dump(f, name, depth = 0) {
  const pad = '  '.repeat(depth);
  // Active locals occupy the lowest registers in declaration order.
  const reg = (r, pc) => f.locals.filter((l) => l.start <= pc && pc < l.end)[r]?.name ?? `r${r}`;
  const rk = (x, pc) => (x >= MAXSTACK ? kstr(f.k[x - MAXSTACK]) : reg(x, pc));
  console.log(`${pad}function ${name} (params ${f.params}${f.vararg ? ', ...' : ''}; line ${f.line})`);
  f.code.forEach((ins, pc) => {
    const op = OPS[ins & 0x3f], a = ins >>> 24, c = (ins >>> 6) & 0x1ff, b = (ins >>> 15) & 0x1ff, bx = (ins >>> 6) & 0x3ffff, sbx = bx - MAXARG_sBX;
    let t;
    switch (op) {
      case 'MOVE': t = `${reg(a, pc)} = ${reg(b, pc)}`; break;
      case 'LOADK': t = `${reg(a, pc)} = ${kstr(f.k[bx])}`; break;
      case 'LOADBOOL': t = `${reg(a, pc)} = ${!!b}${c ? '; skip' : ''}`; break;
      case 'LOADNIL': t = `${reg(a, pc)}..${reg(b, pc)} = nil`; break;
      case 'GETUPVAL': t = `${reg(a, pc)} = upval ${f.upvalues[b] ?? b}`; break;
      case 'GETGLOBAL': t = `${reg(a, pc)} = ${f.k[bx]}`; break;
      case 'GETTABLE': t = `${reg(a, pc)} = ${reg(b, pc)}[${rk(c, pc)}]`; break;
      case 'SETGLOBAL': t = `${f.k[bx]} = ${reg(a, pc)}`; break;
      case 'SETUPVAL': t = `upval ${f.upvalues[b] ?? b} = ${reg(a, pc)}`; break;
      case 'SETTABLE': t = `${reg(a, pc)}[${rk(b, pc)}] = ${rk(c, pc)}`; break;
      case 'NEWTABLE': t = `${reg(a, pc)} = {}`; break;
      case 'SELF': t = `${reg(a + 1, pc)} = ${reg(b, pc)}; ${reg(a, pc)} = ${reg(b, pc)}[${rk(c, pc)}]`; break;
      case 'ADD': case 'SUB': case 'MUL': case 'DIV': case 'POW':
        t = `${reg(a, pc)} = ${rk(b, pc)} ${{ ADD: '+', SUB: '-', MUL: '*', DIV: '/', POW: '^' }[op]} ${rk(c, pc)}`; break;
      case 'UNM': t = `${reg(a, pc)} = -${reg(b, pc)}`; break;
      case 'NOT': t = `${reg(a, pc)} = not ${reg(b, pc)}`; break;
      case 'CONCAT': t = `${reg(a, pc)} = ${reg(b, pc)} .. ... .. ${reg(c, pc)}`; break;
      case 'JMP': t = `goto ${pc + 1 + sbx}`; break;
      case 'EQ': case 'LT': case 'LE':
        t = `if (${rk(b, pc)} ${{ EQ: '==', LT: '<', LE: '<=' }[op]} ${rk(c, pc)}) ~= ${!!a} then skip next`; break;
      case 'TEST': t = `if ${reg(b, pc)} ~= ${!!c} then skip next else ${reg(a, pc)} = ${reg(b, pc)}`; break;
      case 'CALL': t = `${c === 0 ? 'top' : c === 1 ? '' : `${reg(a, pc)}..${reg(a + c - 2, pc)} = `}call ${reg(a, pc)}(${b === 0 ? 'top' : Array.from({ length: b - 1 }, (_, i) => reg(a + 1 + i, pc)).join(', ')})`; break;
      case 'TAILCALL': t = `return call ${reg(a, pc)}(...)`; break;
      case 'RETURN': t = `return ${b === 0 ? 'top' : Array.from({ length: b - 1 }, (_, i) => reg(a + i, pc)).join(', ')}`; break;
      case 'FORLOOP': t = `for ${reg(a, pc)} += step; if <= limit goto ${pc + 1 + sbx}`; break;
      case 'TFORLOOP': t = `generic for ${reg(a, pc)}`; break;
      case 'TFORPREP': t = `tforprep goto ${pc + 1 + sbx}`; break;
      case 'SETLIST': case 'SETLISTO': t = `${reg(a, pc)}[...] = list`; break;
      case 'CLOSE': t = `close ${reg(a, pc)}`; break;
      case 'CLOSURE': t = `${reg(a, pc)} = closure #${bx}`; break;
      default: t = `?${ins & 0x3f}`;
    }
    console.log(`${pad}  ${String(pc).padStart(4)}  ${op.padEnd(9)} ${t}`);
  });
  f.protos.forEach((child, i) => dump(child, `${name}/#${i}`, depth + 1));
}

const bytes = await load(process.argv[2]);
dump(parse(bytes), 'main');
