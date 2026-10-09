// Runs only inside Bubblewrap. No credentials or host resource discovery.
const sdk = await import(process.argv[2]);
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 262144) throw new Error('Tool input too large');
}
try {
  const { tool, args } = JSON.parse(input);
  const factories = { read: 'createReadTool', grep: 'createGrepTool', find: 'createFindTool', ls: 'createLsTool',
    write: 'createWriteTool', edit: 'createEditTool', bash: 'createBashTool' };
  if (!Object.hasOwn(factories, tool)) throw new Error('Unknown tool');
  const implementation = sdk[factories[tool]](process.cwd());
  const result = await implementation.execute('sandbox', args, new AbortController().signal);
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error.message).slice(0, 8192) }));
}
