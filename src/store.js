// Banco de dados em arquivo JSON dentro de DATA_DIR.
// Sem dependências nativas (funciona igual em Windows e Linux, em qualquer Node >= 20).
// Um único processo escreve; cada alteração é gravada na hora com escrita atômica
// (arquivo temporário + rename), então uma queda não corrompe o banco.
import fs from 'node:fs';
import path from 'node:path';

const COLLECTIONS = ['customers', 'children', 'subscriptions', 'orders', 'stories'];

export class Store {
  constructor(file) {
    this.file = file;
    this.depth = 0;
    this.data = { seq: {}, kv: {} };
    for (const name of COLLECTIONS) this.data[name] = [];
    if (fs.existsSync(file)) {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.save();
    }
  }

  save() {
    if (this.depth > 0) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
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
