// Static asset fallback. The public demo contains no API or execution route.
export default { fetch() { return new Response('Not found', { status: 404 }); } };
