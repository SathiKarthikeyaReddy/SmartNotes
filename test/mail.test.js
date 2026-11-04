import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, fetchMail, accessToken } from '../mail.js';
import { randomBytes } from 'node:crypto';

test('provider adapters paginate, include spam/promotions, exclude outgoing, and refresh encrypted tokens',async()=>{
  const originalFetch=globalThis.fetch,oldKey=process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY=randomBytes(32).toString('base64');
  const token={access_token:'test-access',refresh_token:'test-refresh',expiresAt:Date.now()+3600000};
  try {
    assert.deepEqual(unseal(seal(token)),token);assert.ok(!seal(token).includes('test-access'));
    let pageCalls=0;
    globalThis.fetch=async(input)=>{
      const u=new URL(input);
      if(u.pathname.endsWith('/messages')) {
        assert.equal(u.searchParams.get('includeSpamTrash'),'true');assert.match(u.searchParams.get('q'),/-in:sent/);
        pageCalls++;return Response.json(pageCalls===1?{messages:[{id:'one'}],nextPageToken:'second'}:{messages:[{id:'two'}]});
      }
      return Response.json({id:u.pathname.endsWith('one')?'one':'two',threadId:'thread',internalDate:String(Date.now()),labelIds:u.pathname.endsWith('one')?['SPAM']:['CATEGORY_PROMOTIONS'],payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'Assessment'},{name:'From',value:'careers@example.com'}],body:{data:Buffer.from('Complete your assessment').toString('base64url')}}});
    };
    const gmail=await fetchMail({id:'g',provider:'gmail',email:'you@example.com',token:seal(token)});
    assert.equal(gmail.length,2);assert.equal(pageCalls,2);assert.equal(gmail[0].folder,'spam');assert.equal(gmail[1].folder,'promotions');assert.equal(gmail[0].body,'Complete your assessment');
    globalThis.fetch=async(input)=>{
      const u=new URL(input);
      for(const f of ['junkemail','sentitems','deleteditems'])if(u.pathname.endsWith(`/mailFolders/${f}`))return Response.json({id:f});
      if(u.searchParams.get('page')==='2')return Response.json({value:[{id:'b',conversationId:'thread2',parentFolderId:'inbox',body:{content:'Follow up'},receivedDateTime:new Date().toISOString()}]});
      return Response.json({value:[{id:'a',conversationId:'thread',parentFolderId:'junkemail',body:{content:'Important'},receivedDateTime:new Date().toISOString()},{id:'sent',parentFolderId:'sentitems'},{id:'draft',isDraft:true}],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/messages?page=2'});
    };
    const outlook=await fetchMail({id:'o',provider:'outlook',token:seal(token)});
    assert.equal(outlook.length,2);assert.equal(outlook[0].folder,'spam');assert.equal(outlook[1].folder,'inbox');
    globalThis.fetch=async()=>Response.json({access_token:'new-access',expires_in:3600});
    const account={provider:'gmail',token:seal({...token,expiresAt:0})};
    assert.equal(await accessToken(account),'new-access');assert.equal(unseal(account.token).refresh_token,'test-refresh');
  } finally {globalThis.fetch=originalFetch;if(oldKey===undefined)delete process.env.ENCRYPTION_KEY;else process.env.ENCRYPTION_KEY=oldKey;}
});
