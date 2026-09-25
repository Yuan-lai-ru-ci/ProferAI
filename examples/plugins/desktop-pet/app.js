const api = window.profer ?? {}
const $ = (id) => document.getElementById(id)
const STORAGE_KEY = 'desktop-pet-state'
const DEFAULT_STATE = { name: '小 Pro', mood: 82, energy: 76, hunger: 68, sleeping: false }
let state = { ...DEFAULT_STATE }
let saveTimer = null

const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)))
const say = (text) => { $('speech').textContent = text }
const setStatus = (text) => { $('status').textContent = text }

function moodText() {
  if (state.sleeping) return '睡得香香'
  if (state.energy < 25) return '有点困了'
  if (state.hunger < 25) return '肚子饿了'
  if (state.mood >= 80) return '元气满满'
  if (state.mood >= 50) return '心情不错'
  return '需要陪伴'
}

function render() {
  $('pet-name-heading').textContent = state.name
  $('mood-value').textContent = state.mood
  $('energy-value').textContent = state.energy
  $('hunger-value').textContent = state.hunger
  $('mood-meter').style.width = `${state.mood}%`
  $('energy-meter').style.width = `${state.energy}%`
  $('hunger-meter').style.width = `${state.hunger}%`
  $('mood-label').textContent = moodText()
  document.body.classList.toggle('sleeping', state.sleeping)
  $('rest').innerHTML = state.sleeping ? '<span>☀️</span> 叫醒我' : '<span>🌙</span> 休息一下'
  $('pet').setAttribute('aria-label', state.sleeping ? '叫醒桌宠' : '摸摸桌宠')
}

async function persist() {
  try {
    await api.storage?.set(STORAGE_KEY, state)
    $('save-state').textContent = '已保存'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => { $('save-state').textContent = '状态会自动保存' }, 1200)
  } catch (error) {
    $('save-state').textContent = '保存失败，请检查插件授权'
    setStatus(error?.message || '无法保存桌宠状态')
  }
}

async function update(nextState, message) {
  state = { ...state, ...nextState }
  render()
  say(message)
  await persist()
}

async function load() {
  try {
    const saved = await api.storage?.get(STORAGE_KEY)
    if (saved && typeof saved === 'object') {
      state = {
        ...DEFAULT_STATE,
        ...saved,
        mood: clamp(Number(saved.mood)),
        energy: clamp(Number(saved.energy)),
        hunger: clamp(Number(saved.hunger)),
        name: typeof saved.name === 'string' && saved.name.trim() ? saved.name.trim().slice(0, 12) : DEFAULT_STATE.name,
        sleeping: saved.sleeping === true,
      }
    }
    render()
    setStatus(state.sleeping ? '嘘……桌宠正在午睡' : '桌宠已就绪，点一下和它互动')
    say(state.sleeping ? '做个好梦……' : '今天也要加油呀！')
  } catch (error) {
    render()
    setStatus('桌宠已启动，但状态暂未保存')
    say(error?.message || '请在插件设置中授权私有存储')
  }
}

$('pet').addEventListener('click', async () => {
  if (state.sleeping) {
    await update({ sleeping: false, energy: clamp(state.energy + 5), mood: clamp(state.mood + 4) }, '醒啦！谢谢你叫我')
    return
  }
  await update({ mood: clamp(state.mood + 5), energy: clamp(state.energy - 1) }, ['嘿嘿，再摸摸～', '被发现啦！', '今天也很喜欢你'][Math.floor(Math.random() * 3)])
})

$('pat').addEventListener('click', async () => {
  if (state.sleeping) return say('嘘……让我再睡五分钟')
  await update({ mood: clamp(state.mood + 10), energy: clamp(state.energy - 2) }, '呼噜呼噜，心情变好了！')
})

$('feed').addEventListener('click', async () => {
  if (state.sleeping) return say('梦里也有小饼干，谢谢！')
  await update({ hunger: clamp(state.hunger + 18), mood: clamp(state.mood + 4), energy: clamp(state.energy + 2) }, '好吃！再来一块就更好了')
})

$('rest').addEventListener('click', async () => {
  if (state.sleeping) {
    await update({ sleeping: false, energy: clamp(state.energy + 22), mood: clamp(state.mood + 3) }, '充满电啦！')
    return
  }
  await update({ sleeping: true, mood: clamp(state.mood + 2) }, '晚安，别忘了也照顾好自己')
})

$('edit-name').addEventListener('click', async () => {
  const name = window.prompt('给桌宠起个名字吧', state.name)
  if (name === null) return
  const nextName = name.trim().slice(0, 12)
  if (!nextName) return say('名字不能为空哦')
  await update({ name: nextName }, `你好，${nextName}！`)
})

$('reset').addEventListener('click', async () => {
  await update({ ...DEFAULT_STATE }, '重新认识一下吧！')
})

void load()
