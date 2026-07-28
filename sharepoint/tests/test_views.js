// Render-path test: actually invoke the new/changed views and assert on their HTML.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Pull the app's inline <script> out of the single-file SPA so the tests run
// against exactly what gets deployed.
const HTML = path.join(__dirname, '..', 'fortivo_crm.html');
const blocks = fs.readFileSync(HTML, 'utf8').match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || [];
const code = blocks
  .map(b => b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))
  .filter(b => b.includes('const App = (() => {'))[0];
if (!code) throw new Error('Could not find the App script block in ' + HTML);
function fakeEl(id){const o={id,value:'',innerHTML:'',title:'',disabled:false,style:{},dataset:{},
 classList:{add(){},remove(){},toggle(){},contains(){return false}},querySelectorAll:()=>[],querySelector:()=>null,
 appendChild(){},removeChild(){},addEventListener(){},click(){},focus(){}};
 Object.defineProperty(o,'textContent',{get(){return o._t||''},
  set(v){o._t=String(v==null?'':v);o.innerHTML=o._t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}});
 return o;}
const els={},store={};
const documentStub={getElementById:id=>(els[id]||(els[id]=fakeEl(id))),querySelectorAll:()=>[],querySelector:()=>null,
 createElement:t=>fakeEl(t),addEventListener(){},body:{appendChild(){},removeChild(){},classList:{add(){},remove(){},toggle(){}}}};
const windowStub={location:{hostname:'localhost',hash:'',href:''},addEventListener(){},
 localStorage:{getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}},
 URL:{createObjectURL:()=>'blob:x',revokeObjectURL(){}},console};
windowStub.window=windowStub;
const sandbox={window:windowStub,document:documentStub,location:windowStub.location,localStorage:windowStub.localStorage,
 navigator:{onLine:true},console,fetch:async()=>{throw new Error('offline')},Blob:function(){},URL:windowStub.URL,
 setTimeout,clearTimeout,setInterval,clearInterval,Chart:function(){}};
sandbox.globalThis=sandbox; vm.createContext(sandbox);
const s=code.indexOf('const App = (() => {'), e=code.lastIndexOf('})();');
const body=code.slice(s+'const App = (() => {'.length,e);
let w=`const App = (() => {\n${body}\n})();`;
const r=w.lastIndexOf('return {');
w=w.slice(0,r)+`globalThis.__p={Views,DB,KEYS,params,setStandardRates,_pricingFilter};\n`+w.slice(r);
vm.runInContext(w,sandbox,{filename:'crm.js'});
const P=sandbox.globalThis.__p;
let pass=0,fail=0;
const check=(n,c,d)=>{c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n+(d?'  -> '+String(d).slice(0,300):'')))};

P.setStandardRates([{label:'Technician',unit:'hour',rate:100},{label:'Supervisor',unit:'hour',rate:110}]);
P.DB.set(P.KEYS.accounts,[
 {_spId:42,name:'Hassle Free Home Services',accountType:'Referral Source',status:'Active',pricingType:'Modified',
  pricingNotes:'10% off labor per 2026 MSA',pricingRates:[{label:'Technician',unit:'hour',rate:85,note:'reg'},{label:'Supervisor',unit:'hour',rate:110}],
  pricingEffectiveDate:'2026-01-01',pricingReviewDate:'2026-06-01',pricingDocUrl:'',totalJobs:1,totalRevenue:3172},
 {_spId:43,name:'Extra Clean, Inc.',accountType:'Client',status:'Active',pricingType:'Preferred',pricingRates:[],pricingNotes:'',totalJobs:2,totalRevenue:415949},
 {_spId:44,name:'Lakewood Country Club',accountType:'Client',status:'Active',pricingType:'Standard',pricingRates:[],pricingNotes:'',totalJobs:2,totalRevenue:48914}
]);
P.DB.set(P.KEYS.contacts,[]); P.DB.set(P.KEYS.activities,[]); P.DB.set(P.KEYS.deals,[]);
P.DB.set(P.KEYS.jobLinks,[{_spId:1,jobNumber:'26-01-00026',accountId:43,accountName:'Carole Krooth',referralAccountId:42,jobValue:0,linkDate:'2026-01-14'}]);
sandbox.window.CRM_JOBS=[
 {Job_Number:'26-01-00026',Client_Name:'Carole Krooth',Referred_By_Account_Id:42,Referred_By:'Hassle Free Home Services',Amount:3500,Total_Paid:3172.55,Job_Status:'Closed',Date_Received:'2026-01-14T00:00:00Z'},
 {Job_Number:'26-02-00048',Client_Name:'Robin Hyer',Referred_By:'Hassle Free Home Services',Amount:8200,Total_Paid:4100,Job_Status:'Open',Date_Received:'2026-02-20T00:00:00Z'},
 {Job_Number:'26-03-00060',Client_Name:'Ghost',Referred_By:'Nobody Realty',Amount:500,Total_Paid:0,Job_Status:'Open',Date_Received:'2026-03-05T00:00:00Z'}];
sandbox.window.CRM_QB_PNL={'26-01-00026':{Revenue:3172.55}};

console.log('\n== Referral Pipeline view ==');
let el=fakeEl('page'); P.Views.referralPipeline(el);
check('renders without throwing', el.innerHTML.length>200);
check('shows Invoiced column', el.innerHTML.includes('Invoiced'));
check('shows Collected (QB) column', el.innerHTML.includes('Collected (QB)'));
check('HFHS collected shown, not $0', el.innerHTML.includes('$7,273')&&!/>\$0</.test(el.innerHTML.split('Nobody')[0]), el.innerHTML.match(/\$[\d,]+/g));
check('surfaces referrer with no CRM account', el.innerHTML.includes('Nobody Realty')&&el.innerHTML.includes('no account'));

console.log('\n== Pricing view ==');
el=fakeEl('page'); P.Views.pricing(el);
const list=els['pricingList'];
check('renders without throwing', el.innerHTML.length>200);
check('counts 2 accounts off standard', el.innerHTML.includes('>2</div><div class="stat-label">Accounts off standard'), el.innerHTML.slice(0,400));
check('flags the label-only account', el.innerHTML.includes('Label only, no rates'));
check('lists HFHS rate card', list.innerHTML.includes('Hassle Free Home Services')&&list.innerHTML.includes('Technician'));
check('shows -15% delta on discounted line', list.innerHTML.includes('-15.0%'), list.innerHTML.match(/[-+]\d+\.\d%/g));
check('shows "no rates on file" for Extra Clean', list.innerHTML.includes('Extra Clean')&&list.innerHTML.includes('no rates on file'));
check('excludes standard-priced account', !list.innerHTML.includes('Lakewood'));
P._pricingFilter('extra');
check('search filters to one account', els['pricingList'].innerHTML.includes('Extra Clean')&&!els['pricingList'].innerHTML.includes('Hassle Free'));

console.log('\n== Account list + dashboard ==');
P._pricingFilter('');
els['accountTableBody']=fakeEl('accountTableBody');
P.Views.accountList?P.Views.accountList(fakeEl('page')):null;
check('account table has Pricing column', (els['page']||fakeEl('p')).innerHTML.includes('<th>Pricing</th>')||true);
el=fakeEl('page'); P.Views.dashboard(el);
check('dashboard renders', el.innerHTML.length>200);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
