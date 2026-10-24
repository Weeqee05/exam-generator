// Controlled application errors are safe to show; unexpected errors stay private.
export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readLimited(stream, limit) {
  let length = 0;
  const chunks = [];
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new RequestError(413, 'Слишком большой запрос или ответ модели.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
