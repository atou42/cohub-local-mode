import readline from 'node:readline';
const mode = process.env.WORKBUDDY_FIXTURE_MODE;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type === 'control_request') {
    if (mode === 'timeout') return;
    if (mode === 'launch-contract' && (!process.argv.includes('--include-partial-messages') || process.argv.includes('--dangerously-skip-permissions') || process.env.CODEBUDDY_HOST !== 'workbuddy-desktop')) return send({type:'control_response',response:{subtype:'error',request_id:value.request_id,error:'Wrong WorkBuddy launch contract'}});
    if (mode === 'malformed') return process.stdout.write('{broken}\n');
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { models: mode === 'bad-catalog' ? [{}] : [{ id: 'model-1', name: 'Model One', description: 'A model', apiKey: 'secret' }], currentModelId: 'model-1', account: { token: 'secret' } } } });
  } else if (value.type === 'user') {
    if (mode === 'top-level-error') return send({type:'error',error:'Authentication required'});
    if (mode === 'exit') { process.stderr.write('private-secret'); return process.exit(7); }
    if (mode === 'permission') return send({ type: 'control_request', request_id: 'perm-test', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo fixture' }, tool_use_id: 'tool-1' } });
    send({ type: 'user', uuid: 'native-user-id', session_id: 'session-1', message: value.message, isReplay: true });
    send({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', result: 'done' });
  } else if (value.type === 'control_response') {
    if (value.response?.request_id !== 'perm-test' || value.response?.response?.allowed !== false) return process.exit(8);
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'session-1', errors: ['Permission denied'] });
  }
});
