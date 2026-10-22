// The comparison runs here, off the extension host's thread. One worker per comparison
// panel; it holds both tables and answers the panel's requests.
import { readFileSync } from 'fs';
import { parentPort } from 'worker_threads';
import { Session, type Side, type SideInput } from './core';
import { decodeText } from './decode';

export { decode, encodingLabel } from './decode';

export type WorkerRequest =
  | { op: 'load'; side: Side; input: Omit<SideInput, 'text'> & { text?: string; path?: string; encoding?: string }; label: string }
  | { op: 'compare'; options: Parameters<Session['compare']>[0]; texts: Record<Side, boolean> }
  | { op: 'window'; from: number; to: number; cols?: number[] }
  | { op: 'search'; query: Parameters<Session['search']>[0] }
  | { op: 'export'; format: Parameters<Session['export']>[0]; limit?: number }
  | { op: 'lines'; side: Side }
  | { op: 'swap' };

const session = new Session();

function handle(req: WorkerRequest): unknown {
  switch (req.op) {
    case 'load': {
      // Big files are read here, so the text is never copied through the host.
      let text = req.input.text;
      let warning: string | undefined;
      if (text === undefined) ({ text, warning } = decodeText(readFileSync(req.input.path!), req.input.encoding));
      session.labels[req.side] = req.label;
      return session.load(req.side, { ...req.input, text, warnings: warning ? [warning] : undefined });
    }
    case 'compare':
      return session.compare(req.options, req.texts);
    case 'window':
      return session.window(req.from, req.to, req.cols);
    case 'search':
      return session.search(req.query);
    case 'export':
      return session.export(req.format, req.limit);
    case 'lines':
      return session.lines(req.side);
    case 'swap':
      session.swap();
      return true;
  }
}

parentPort!.on('message', (m: { id: number; req: WorkerRequest }) => {
  try {
    parentPort!.postMessage({ id: m.id, result: handle(m.req) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
