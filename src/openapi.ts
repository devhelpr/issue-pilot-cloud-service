export const openapi = {
  openapi: '3.1.0', info: { title: 'Issue Pilot Cloud Service', version: 'v1' },
  paths: {
    '/health': { get: { responses: { '200': { description: 'Service is available' } } } },
    '/github/webhook': { post: { responses: { '202': { description: 'Webhook accepted' }, '401': { description: 'Invalid signature' } } } },
    '/v1/repositories': { get: { security: [{ bearerAuth: [] }], parameters: [{ name: 'cursor', in: 'query' }, { name: 'limit', in: 'query' }], responses: { '200': { description: 'Refreshes GitHub App repositories, then returns cursor-paginated { items, next_cursor }' }, '401': { description: 'GitHub App or desktop authentication failed' }, '403': { description: 'GitHub App access was denied or rate-limited' }, '500': { description: 'Unexpected service error' } } } },
    '/v1/issues': { get: { security: [{ bearerAuth: [] }], parameters: [{ name: 'cursor', in: 'query' }, { name: 'limit', in: 'query' }], responses: { '200': { description: 'Cursor-paginated issues: { items, next_cursor }' } } } },
    '/v1/issues/{id}/approve': { post: { security: [{ bearerAuth: [] }], responses: { '201': { description: 'Job queued' }, '409': { description: 'Issue changed or active job exists' } } } },
    '/v1/jobs': { get: { security: [{ bearerAuth: [] }], parameters: [{ name: 'cursor', in: 'query' }, { name: 'limit', in: 'query' }], responses: { '200': { description: 'Cursor-paginated jobs: { items, next_cursor }' } } } },
    '/v1/jobs/{id}/claim': { post: { security: [{ bearerAuth: [] }], responses: { '200': { description: 'Job claimed' }, '409': { description: 'Already claimed' } } }, get: { security: [{ bearerAuth: [] }], parameters: [{ name: 'claim_id', in: 'query', required: true }], responses: { '200': { description: 'Claim validity immediately before external writes' } } } },
    '/v1/jobs/{id}/status': { post: { security: [{ bearerAuth: [] }], responses: { '200': { description: 'Progress or stored terminal reconciliation result' }, '409': { description: 'Stale claim or stop requested' } } } }
  }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }
};
