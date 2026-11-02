// Grok Build 1.0.70 writes structured text blocks, including synthetic user
// records containing startup instructions. Older histories used plain strings.
export const grokText = record => typeof record?.content === 'string' ? record.content
  : Array.isArray(record?.content) ? record.content.filter(part=>part?.type==='text' && typeof part.text==='string').map(part=>part.text).join('\n') : '';
export const grokSynthetic = record => typeof record?.synthetic_reason === 'string' && record.synthetic_reason.length>0;
export const grokFinal = record => record?.type==='assistant' && !grokSynthetic(record) && !record.tool_calls?.length && !!grokText(record).trim();
export function grokRecordProblem(record) {
  if (!['user','assistant','system','tool'].includes(record.type)) return `Unknown Grok record type: ${record.type}`;
  if (!['user','assistant'].includes(record.type)) return null;
  if (record.synthetic_reason !== undefined && typeof record.synthetic_reason!=='string') return 'Unsupported Grok synthetic metadata';
  const tools=record.tool_calls;
  if (tools!==undefined && (!Array.isArray(tools) || tools.some(tool=>tool?.type!=='function' || typeof tool.id!=='string' || typeof tool.function?.name!=='string' || typeof tool.function?.arguments!=='string'))) return 'Unsupported Grok tool-call format';
  if (record.type==='assistant' && record.content==null && tools?.length) return null;
  if (typeof record.content==='string') return null;
  if (Array.isArray(record.content) && record.content.every(part=>part?.type==='text' && typeof part.text==='string')) return null;
  return 'Unsupported Grok message format';
}
