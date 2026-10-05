// Banco de dados em arquivo JSON dentro de DATA_DIR.
// Sem dependências nativas (funciona igual em Windows e Linux, em qualquer Node >= 20).
// Um único processo escreve; cada alteração é gravada na hora com escrita atômica
// (arquivo temporário com fsync + rename) e a versão anterior fica em store.json.bak.
// Se o arquivo principal estiver vazio ou corrompido, o banco abre pela cópia .bak.
import fs from 'node:fs';
import path from 'node:path';

const COLLECTIONS = ['customers', 'children', 'subscriptions', 'orders', 'stories', 'emails'];

export class Store {
  constructor(file) {
    this.file = file;
    this.backup = `${file}.bak`;
    this.depth = 0;
    this.data = { seq: {}, kv: {} };
    for (const name of COLLECTIONS) this.data[name] = [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const loaded = Store.read(file) ?? Store.read(this.backup);
    if (loaded) {
      if (!Store.read(file)) console.error(`Banco principal ilegível; aberto pela cópia ${this.backup}.`);
      Object.assign(this.data, loaded);
    } else if (fs.existsSync(file) || fs.existsSync(this.backup)) {
      throw new Error(`Banco de dados ilegível: ${file} (e a cópia .bak). Restaure um backup da pasta DATA_DIR.`);
    } else {
      this.save();
    }
  }

  // Lê e valida um arquivo do banco; devolve null se não existir ou estiver corrompido.
  static read(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }

  save() {
    if (this.depth > 0) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Se cair entre os dois renames, o construtor abre pela cópia .bak.
    if (fs.existsSync(this.file)) fs.renameSync(this.file, this.backup);
    fs.renameSync(tmp, this.file);
  }

  // Agrupa várias alterações numa única gravação.
  transaction(fn) {
    this.depth += 1;
    try {
      return fn();
    } finally {
      this.depth -= 1;
      this.save();
    }
  }

  all(collection) {
    return this.data[collection];
  }

  get(collection, id) {
    return this.data[collection].find((row) => row.id === Number(id)) || null;
  }

  find(collection, predicate) {
    return this.data[collection].find(predicate) || null;
  }

  filter(collection, predicate) {
    return this.data[collection].filter(predicate);
  }

  insert(collection, row) {
    const id = (this.data.seq[collection] || 0) + 1;
    this.data.seq[collection] = id;
    const record = { id, ...row };
    this.data[collection].push(record);
    this.save();
    return record;
  }

  update(collection, id, patch) {
    const row = this.get(collection, id);
    if (!row) return null;
    Object.assign(row, patch);
    this.save();
    return row;
  }

  remove(collection, predicate) {
    const before = this.data[collection].length;
    this.data[collection] = this.data[collection].filter((row) => !predicate(row));
    this.save();
    return before - this.data[collection].length;
  }

  kvGet(key, fallback = null) {
    return this.data.kv[key] ?? fallback;
  }

  kvSet(key, value) {
    this.data.kv[key] = value;
    this.save();
  }
}

let current = null;

export function openStore(file) {
  current = new Store(file);
  return current;
}

export function db() {
  if (!current) throw new Error('Banco não aberto: chame openStore() antes.');
  return current;
}
