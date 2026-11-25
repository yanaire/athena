const fixture = process.argv.find(value => /tests[\\/][^\\/]+\.test\./.test(value))?.split(/[\\/]/).at(-1) ?? 'test-runner';
console.error('[fixture-resources]', JSON.stringify({ fixture, pid: process.pid, phase: 'started' }));
setInterval(() => console.error('[fixture-resources]', JSON.stringify({
  fixture, pid: process.pid, resources: process.getActiveResourcesInfo(),
})), 5000).unref();
