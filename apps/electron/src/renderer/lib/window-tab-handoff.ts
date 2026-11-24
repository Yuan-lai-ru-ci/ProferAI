import type { createStore } from 'jotai/vanilla';
import type { MainWindowTabPayload, WindowTabHandoffEvent } from '@profer/shared';
import { coreSessionNavigationPhaseAtom, coreTargetsAtom } from '../atoms/core-target-atoms';
import { tabsAtom, openTab, type TabItem } from '../atoms/tab-atoms';
import { agentSessionDraftsAtom, agentSessionDraftHtmlAtom } from '../atoms/agent-atoms';
import { conversationDraftsAtom } from '../atoms/chat-atoms';
import { toast } from 'sonner';
import { clearMovedDraft, detachMovedTab, matchesMoveCore, sameMovedSnapshot, snapshotSessionForMove, type SyncMovedTab } from './window-session-move';
type Store = ReturnType<typeof createStore>;
interface Pending {
    source?: { generation: number; item: TabItem; sync: SyncMovedTab };
    tab: MainWindowTabPayload;
}
const states = new WeakMap<Store, {
    pending: Map<string, Pending>;
    events: Map<string, WindowTabHandoffEvent>;
    done: Set<string>;
    acking: Set<string>;
    restored: Set<string>;
}>();
function state(store: Store) {
    let value = states.get(store);
    if (!value) {
        value = { pending: new Map(), events: new Map(), done: new Set(), acking: new Set(), restored: new Set() };
        states.set(store, value);
    }
    return value;
}
export function receiveHandoff(store: Store, event: WindowTabHandoffEvent, recoverable = false): void {
    const value = state(store);
    if (value.done.has(event.handoffId))
        return;
    const pending = value.pending.get(event.handoffId);
    if (!pending && !recoverable) {
        value.events.set(event.handoffId, event);
        return;
    }
    const tab = pending?.tab ?? event.tab;
    if (event.status === 'committed') {
        if (!pending)
            return;
        if (pending.source) {
            if (!matchesMoveCore(store, { ...event.sourceCore, generation: pending.source.generation })) {
                finish(store, event.handoffId);
                return;
            }
            const current = snapshotSessionForMove(store, tab);
            if (!store.get(tabsAtom).includes(pending.source.item) || !('tab' in current) || !sameMovedSnapshot(tab, current.tab)) {
                toast.warning('会话已送达目标窗口，但源窗口内容已变化，原标签已保留');
                finish(store, event.handoffId);
                return;
            }
            detachMovedTab(store, tab, pending.source.sync);
        }
        clearMovedDraft(store, tab);
    }
    else {
        const core = store.get(coreTargetsAtom);
        const selected = core.targets.find(item => item.id === core.currentId);
        if (store.get(coreSessionNavigationPhaseAtom) !== 'ready' || core.startup === 'restoring' || core.startup === 'offline' || core.currentId !== event.sourceCore.targetId || selected?.coreId !== event.sourceCore.coreId) {
            value.done.delete(event.handoffId);
            value.events.set(event.handoffId, event);
            return;
        }
        if (!value.restored.has(event.handoffId)) {
            store.set(tabsAtom, openTab(store.get(tabsAtom), tab).tabs);
            const atom = tab.type === 'agent' ? agentSessionDraftsAtom : conversationDraftsAtom;
            if (tab.draft !== undefined)
                store.set(atom, previous => previous.has(tab.sessionId) ? previous : new Map(previous).set(tab.sessionId, tab.draft!));
            if (tab.type === 'agent' && tab.draftHtml !== undefined)
                store.set(agentSessionDraftHtmlAtom, previous => previous.has(tab.sessionId) ? previous : new Map(previous).set(tab.sessionId, tab.draftHtml!));
            value.restored.add(event.handoffId);
            toast.error(event.error ?? '移窗失败，会话已恢复');
        }
        value.events.set(event.handoffId, event);
        if (value.acking.has(event.handoffId))
            return;
        value.acking.add(event.handoffId);
        void window.electronAPI.ackWindowTabHandoff(event.handoffId).then(() => finish(store, event.handoffId)).catch(console.error).finally(() => value.acking.delete(event.handoffId));
        return;
    }
    finish(store, event.handoffId);
}
function finish(store: Store, id: string): void {
    const value = state(store);
    value.pending.delete(id);
    value.events.delete(id);
    value.restored.delete(id);
    value.done.add(id);
    if (value.done.size > 256)
        value.done.delete(value.done.values().next().value!);
}
export function trackHandoff(store: Store, id: string, tab: MainWindowTabPayload, _coreId: string, source?: Pending['source']): void {
    const value = state(store);
    if (value.done.has(id))
        return;
    value.pending.set(id, { tab, source });
    const event = value.events.get(id);
    if (event) {
        value.events.delete(id);
        receiveHandoff(store, event);
    }
}
export function retryFailedHandoffs(store: Store): void {
    const value = state(store);
    for (const event of [...value.events.values()]) {
        receiveHandoff(store, event, true);
    }
}
export function subscribeHandoffRecovery(store: Store): () => void {
    const stops = [coreTargetsAtom, coreSessionNavigationPhaseAtom].map(atom => store.sub(atom, () => retryFailedHandoffs(store)));
    return () => stops.forEach(stop => stop());
}
