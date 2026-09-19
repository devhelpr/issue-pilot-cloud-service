export const openapi = {
  openapi: '3.1.0', info: { title: 'Issue Pilot Cloud Service', version: 'v1' },
  paths: {
    '/health': { get: { responses: { '200': { description: 'Service is available' } } } },
    '/github/webhook': { post: { responses: { '202': { description: 'Webhook accepted' }, '401': { description: 'Invalid signature' } } } },
    '/v1/repositories': { get: { security: [{ bearerAuth: [] }], responses: { '200': { description: 'Repositories' } } } },
    '/v1/issues': { get: { security: [{ bearerAuth: [] }], responses: { '200': { description: 'Issues' } } } },
    '/v1/issues/{id}/approve': { post: { security: [{ bearerAuth: [] }], responses: { '201': { description: 'Job queued' }, '409': { description: 'Issue changed or active job exists' } } } },
    '/v1/jobs': { get: { security: [{ bearerAuth: [] }], responses: { '200': { description: 'Jobs' } } } },
    '/v1/jobs/{id}/claim': { post: { security: [{ bearerAuth: [] }], responses: { '200': { description: 'Job claimed' }, '409': { description: 'Already claimed' } } } }
  }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }
};
