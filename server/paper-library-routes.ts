import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {listPapers} from './paper-library';
import type {Store} from './store';

const query=z.object({
  conversationId:z.string().uuid().optional(),
  q:z.string().trim().max(300).optional(),
  scope:z.enum(['metadata','abstract','full_text']).optional(),
  resource:z.enum(['reader','cached_pdf','external']).optional(),
  offset:z.coerce.number().int().min(0).max(10_000_000).default(0),
  limit:z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export function registerPaperLibraryRoutes(app:FastifyInstance,store:Store):void {
  app.get('/api/projects/:id/papers',async request=>{
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    return listPapers(store,id,query.parse(request.query));
  });
}
