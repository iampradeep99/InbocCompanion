import { PDFParse } from 'pdf-parse';

process.once('message', async data => {
  const parser = new PDFParse({ data: new Uint8Array(data), isEvalSupported: false });
  let response;
  try {
    const info = await parser.getInfo();
    if (info.total > 10) throw new Error('Upload a ticket PDF with at most 10 pages.');
    const result = await parser.getText();
    response = { text: result.text };
  } catch (error) {
    response = { error: error.name === 'PasswordException' ? 'This PDF is password protected. Upload an unlocked copy.' : 'Unable to read this PDF. Use an unlocked, text-based ticket PDF with at most 10 pages.' };
  } finally { await parser.destroy(); }
  process.send(response);
});
