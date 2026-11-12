import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from './store';
import { LibraryStore } from './library';
import { libraryBibtex } from './library-bibtex';

const projectParams = z.object({ projectId: z.string().uuid() });
const itemParams = projectParams.extend({ itemId: z.string().uuid() });
const collectInput = z.object({ runId: z.string().uuid(), evidenceId: z.string().min(1).max(200) }).strict();
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const updateInput = z.object({
  revision,
  tags: z.array(z.string().max(200)).max(12).optional(),
  note: z.string().max(10000).optional(),
  readingStatus: z.enum(['unread', 'reading', 'read']).optional(),
}).strict().refine(value => value.tags !== undefined || value.note !== undefined || value.readingStatus !== undefined, '请提供需要保存的整理信息');

/** These routes only organize existing records. They never run research or fetch sources. */
export function registerLibraryRoutes(app: FastifyInstance, store: Store): void {
  const library = new LibraryStore(store);
  app.get('/api/projects/:projectId/library', async request => {
    const { projectId } = projectParams.parse(request.params);
    return library.list(projectId);
  });
  app.get('/api/projects/:projectId/library/export.bib', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const items = library.list(projectId);
    reply.header('Content-Disposition', 'attachment; filename="zhicui-library.bib"');
    return reply.type('application/x-bibtex; charset=utf-8').send(libraryBibtex(items));
  });
  app.post('/api/projects/:projectId/library', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const result = library.collect(projectId, collectInput.parse(request.body));
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.patch('/api/projects/:projectId/library/:itemId', async request => {
    const { projectId, itemId } = itemParams.parse(request.params);
    return library.update(projectId, itemId, updateInput.parse(request.body));
  });
  app.delete('/api/projects/:projectId/library/:itemId', async (request, reply) => {
    const { projectId, itemId } = itemParams.parse(request.params);
    const input = z.object({ revision }).strict().parse(request.body);
    library.remove(projectId, itemId, input.revision);
    return reply.code(204).send();
  });
}
