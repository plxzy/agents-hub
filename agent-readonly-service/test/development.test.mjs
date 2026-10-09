import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch } from '../src/worker-core.mjs';
import { GrantAuthority } from '../../agent-workflow/dev-grants.mjs';
import { developmentCall } from '../src/development.mjs';
import { developmentTools, validateDevelopment } from '../../agent-workflow/dev-contract.mjs';

test('development MCP binds the authenticated owner and keeps click credentials out of ordinary results', async () => {
  const data = new Map(), process_session = 'process-00000001';
  const authority = new GrantAuthority({ get: id => structuredClone(data.get(id)), put: (id,r) => data.set(id,structuredClone(r)), list: () => [...data.values()] }, { processSession: () => process_session });
  const manifest = { host:'dok-dev', project:'dev-workflow', agent:'workflow', process_session, conversation_id:'conversation-0001', workspace_id:'workspace-0001', implementation_revision:'revision-0001', knowledge_revision:'knowledge-0001', policy_digest:'policy-00001' };
  let dispatches=0;
  const stub = {
    developmentPrevious: () => null,
    dispatch: async () => { dispatches++; return { ok:true, value:manifest }; },
    developmentRequest: (...a) => authority.request(...a),
    developmentGet: (...a) => authority.get(...a),
    developmentAuthorize: (...a) => authority.authorize(...a),
    developmentDecide: (...a) => authority.decide(...a),
    developmentPanel: async (owner, privateCodes) => {
      const grants=authority.list(owner), confirm={};
      if(privateCodes) for(const g of grants) confirm[g.grant_id]={decision:'approve',token:await authority.issue(owner,g.grant_id,'approve')};
      return {grants,...(privateCodes?{confirm}:{} )};
    },
  };
  const env={DOK_RELAY_TOKEN:'synthetic-only',DEVELOPMENT_ENABLED:'true',RELAY:{getByName(name){assert.equal(name,'owner-dok-dev');return stub;}}};
  const call=async(name,args={},owner='owner')=>{
    const r=await apiFetch(new Request('https://test/mcp',{method:'POST',body:JSON.stringify({id:1,method:'tools/call',params:{name,arguments:args}})}),env,'',owner);
    return (await r.json()).result;
  };
  assert.equal((await call('request_development',{request_id:'request-0001'},null)).isError,true);
  const pending=await call('request_development',{request_id:'request-0001'});
  const grant=JSON.parse(pending.content[0].text);
  assert.equal(dispatches,1);
  assert.equal(pending.structuredContent.view,'development');
  assert.equal(pending.structuredContent.grant_id,grant.grant_id);
  assert.equal(pending.structuredContent.status,'pending');
  assert.equal(pending._meta,undefined); // click credentials come only from the app-only panel
  assert.equal((await call('start_development_task',{request_id:'request-task',grant_id:grant.grant_id,conversation_id:manifest.conversation_id,task:'Plan 1B'})).isError,true);
  assert.equal(dispatches,1); // preparing a clone is allowed; launching Pi before approval is not
  assert.equal((await call('decide_development',{grant_id:grant.grant_id,decision:'approve',confirm:'x'.repeat(72)})).isError,true);
  const panel=await call('development_panel');
  const code=panel._meta['agents-hub/development-confirm'][grant.grant_id].token;
  assert.equal(JSON.stringify(panel.content).includes(code),false);
  assert.equal(JSON.stringify(await call('get_development')).includes(code),false);
  assert.equal((await call('decide_development',{grant_id:grant.grant_id,decision:'approve',confirm:code},'other')).isError,true);
  assert.equal((await call('decide_development',{grant_id:grant.grant_id,decision:'approve',confirm:code})).isError,undefined);
  assert.equal((await call('decide_development',{grant_id:grant.grant_id,decision:'approve',confirm:code})).isError,true);
  await assert.rejects(developmentCall(env,'owner','start_development_task',{request_id:'request-task',grant_id:grant.grant_id,conversation_id:'wrong-conversation',task:'edit'}),/Conversation/);
  assert.equal(dispatches,1);
  assert.equal(await call('dev_start',{}),undefined); // unknown JSON-RPC tool error, not dispatch
  assert.equal(dispatches,1);
});

test('host commands are absent from MCP discovery and cannot be validated as user operations', () => {
  assert.throws(()=>validateDevelopment('dev_start',{}));
  const tools=developmentTools();
  assert.ok(!tools.some(t=>t.name.startsWith('dev_')));
  assert.deepEqual(tools.find(t=>t.name==='decide_development')._meta.ui.visibility,['app']);
  assert.deepEqual(tools.find(t=>t.name==='development_panel')._meta.ui.visibility,['app']);
  assert.match(tools.find(t=>t.name==='request_development')._meta.ui.resourceUri,/dashboard-v\d+\.html$/);
});

test('legacy workflow start explains the approval route without dispatching to either host', async () => {
  const env={RELAY_TOKEN:'synthetic-only',RELAY:{getByName(){throw new Error('must not dispatch');}}};
  const response=await apiFetch(new Request('https://test/mcp',{method:'POST',body:JSON.stringify({id:1,method:'tools/call',params:{name:'start_run',arguments:{agent:'workflow',task:'Plan 1B',request_id:'legacy-request'}}})}),env,'','owner');
  const result=(await response.json()).result;
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/request_development/);
  assert.match(result.content[0].text,/No task was started/);
});
