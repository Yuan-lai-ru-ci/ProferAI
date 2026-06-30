	// ---- Channels ----
	// 代管模式下，API Key / Base URL 在 New API 后台配置，Profer 渠道仅管理
	// 「显示哪些模型、走什么供应商协议」。真正的上游鉴权由代理中继站统一处理。
	function renderChannels(c){
	  var show=false,nm='',prov='deepseek',models='',editingId='';
	  function load(){
	    c.innerHTML='<h1 class="page-title">渠道管理</h1><div class="card"><span style="color:var(--muted)">加载中...</span></div>';
	    api('/admin/channels').then(function(chs){
	      var rows=chs.length?chs.map(function(ch){
	        var mlist='';var mjson='';try{var ms=JSON.parse(ch.models_json||'[]')||[];mlist=ms.map(function(m){return m.name||m.id}).join(', ');mjson=JSON.stringify(ms)}catch(e){}
	        return'<tr><td><strong>'+esc(ch.name)+'</strong></td><td>'+ch.provider+'</td><td style="max-width:220px;font-size:12px;color:var(--muted)">'+esc(mlist||'—')+'</td><td>'+(ch.is_active?'<span class="badge badge-success">活跃</span>':'<span class="badge badge-danger">停用</span>')+'</td><td>'+fmtDate(ch.created_at)+'</td><td><button class="btn btn-ghost edit-ch-btn" data-cid="'+ch.id+'" data-nm="'+esc(ch.name)+'" data-prov="'+ch.provider+'" data-models="'+esc(mjson)+'" data-active="'+ch.is_active+'">✏️ 编辑</button> <button class="btn btn-ghost del-btn" data-cid="'+ch.id+'" style="color:var(--danger)">🗑 删除</button></td></tr>'
	      }).join(''):'<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">📡</div>还没有配置渠道</div></td></tr>';
	      c.innerHTML='<h1 class="page-title">渠道管理</h1>';
	      c.insertAdjacentHTML('beforeend','<div class="card" style="margin-bottom:20px;border-left:3px solid var(--primary);background:rgba(59,130,246,.06)"><div style="font-size:13px;line-height:1.6">ℹ️ <strong>代管模式说明</strong>：API Key 和上游地址在 <a href="/" target="_blank" style="color:var(--primary)">New API 后台</a> 统一配置，此处的渠道仅管理<strong>供应商类型</strong>和<strong>可用模型清单</strong>。</div></div>');
	      c.insertAdjacentHTML('beforeend','<div style="margin-bottom:16px"><button class="btn btn-primary toggle-btn">'+(show?'✕ 取消':'＋ 创建渠道')+'</button></div>');
	      if(show){
	        c.insertAdjacentHTML('beforeend','<div class="card form-card" style="max-width:560px">'+
	          '<div class="card-header"><h2>'+(editingId?'编辑渠道':'创建渠道')+'</h2></div>'+
	          '<div class="form-row"><div><label>名称</label><input class="ch-name" value="'+esc(nm)+'"></div><div><label>供应商</label><select class="ch-provider"><option value="deepseek"'+(prov==='deepseek'?' selected':'')+'>DeepSeek</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="qwen">通义千问</option><option value="kimi-api">Kimi</option><option value="zhipu">智谱</option><option value="minimax">MiniMax</option><option value="doubao">豆包</option></select></div></div>'+
	          '<div class="form-row"><div><label>模型清单（JSON，每项含 id/name/enabled）</label>'+
	          '<textarea class="ch-models" rows="4" style="font-size:12px;font-family:monospace" placeholder=\'[{"id":"deepseek-v4-flash","name":"DeepSeek V4 Flash","enabled":true}]\'>'+esc(models)+'</textarea></div></div>'+
	          '<div class="test-msg" style="font-size:13px;margin-bottom:12px"></div>'+
	          '<button class="btn btn-primary create-btn">'+(editingId?'保存修改':'创建渠道')+'</button></div>');
	        c.querySelector('.create-btn').addEventListener('click',function(){
	          var n=c.querySelector('.ch-name').value,p=c.querySelector('.ch-provider').value,ms=c.querySelector('.ch-models').value;
	          if(!n){toast('名称必填',false);return}
	          try{JSON.parse(ms||'[]')}catch(e){toast('模型清单必须是合法 JSON',false);return}
	          if(editingId){
	            api('/admin/channels/'+editingId,{method:'PATCH',body:JSON.stringify({name:n,provider:p,modelsJson:ms})}).then(function(){toast('渠道已更新');editingId='';show=false;load()}).catch(function(e){toast(e.message,false)});
	          }else{
	            api('/admin/channels',{method:'POST',body:JSON.stringify({name:n,provider:p,modelsJson:ms})}).then(function(){toast('渠道创建成功');show=false;load()}).catch(function(e){toast(e.message,false)});
	          }
	        });
	      }
	      c.insertAdjacentHTML('beforeend','<div class="card" style="overflow:auto"><table><thead><tr><th>名称</th><th>供应商</th><th>模型</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>'+rows+'</tbody></table></div>');
	      c.querySelector('.toggle-btn').addEventListener('click',function(){show=!show;load()});
	      c.querySelectorAll('.edit-ch-btn').forEach(function(b){b.addEventListener('click',function(){nm=b.dataset.nm;prov=b.dataset.prov;models=b.dataset.models||'';editingId=b.dataset.cid;show=true;load()})});c.querySelectorAll('.del-btn').forEach(function(b){b.addEventListener('click',function(){if(!confirm('确定删除该渠道？'))return;api('/admin/channels/'+b.dataset.cid,{method:'DELETE'}).then(function(){toast('已删除');load()})})});
	    }).catch(function(e){c.innerHTML='<h1 class="page-title">渠道管理</h1><div class="card"><div class="empty-state"><div class="empty-icon">⚠️</div>'+e.message+'</div></div>'});
	  }
	  load();
	}
