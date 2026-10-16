import { parentPort, workerData } from 'node:worker_threads';
import { PDFParse } from 'pdf-parse';

const parser = new PDFParse({ data: new Uint8Array(workerData), isEvalSupported: false });
try {
  const info = await parser.getInfo();
  if (info.total > 10) throw new Error('Upload a ticket PDF with at most 10 pages.');
  const result = await parser.getText();
  parentPort.postMessage({ text: result.text });
} catch (error) {
  parentPort.postMessage({ error: error.name === 'PasswordException' ? 'This PDF is password protected. Upload an unlocked copy.' : 'Unable to read this PDF. Use an unlocked, text-based ticket PDF with at most 10 pages.' });
} finally { await parser.destroy(); }
