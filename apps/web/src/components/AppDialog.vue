<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** 危险操作（删除类）用红色确认按钮 */
    danger?: boolean;
    busy?: boolean;
  }>(),
  { confirmLabel: '确定', cancelLabel: '取消', danger: false, busy: false },
);

const emit = defineEmits<{ close: []; confirm: [] }>();

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      window.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    } else {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    }
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="mask" @click.self="emit('close')">
        <div class="panel glass" role="dialog" aria-modal="true">
          <h2 class="title">{{ title }}</h2>
          <div class="body"><slot /></div>
          <div class="foot">
            <button type="button" class="ghost" :disabled="busy" @click="emit('close')">
              {{ cancelLabel }}
            </button>
            <button
              type="button"
              class="major"
              :class="{ 'is-danger': danger }"
              :disabled="busy"
              @click="emit('confirm')"
            >
              {{ busy ? '处理中…' : confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/*
 * 22 = 比侧栏（.rail 20）和笔记动作菜单（NoteActionMenu 21）都高。
 * 原先是 20，与侧栏同层、只靠 DOM 顺序取胜，纯属侥幸；一旦菜单也要抬到侧栏之上，
 * 「菜单之上、其它都之下」就必须用明确的数字表达。
 */
.mask {
  position: fixed;
  inset: 0;
  z-index: 22;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-2);
  /* 面板居中于**内容列**而不是视口（桌面端侧栏让出的宽度由 --content-offset 表达） */
  padding-left: calc(var(--sp-2) + var(--content-offset));
  background: rgba(0, 0, 0, 0.42);
}

.panel {
  width: 100%;
  max-width: 380px;
  padding: var(--sp-3) var(--sp-2) var(--sp-2);
  border-radius: var(--r-xl);
  background: var(--glass-bg);
}

.title {
  font-size: 17px;
  font-weight: 620;
  margin-bottom: var(--sp-2);
}

.body {
  margin-bottom: var(--sp-3);
}

.foot {
  display: flex;
  gap: var(--sp-1);
}

.foot button {
  flex: 1 1 0;
  height: 44px;
  border-radius: var(--r-md);
  font-size: 15px;
  font-weight: 600;
  transition:
    transform var(--dur-fast) var(--ease-spring),
    opacity var(--dur) var(--ease-smooth);
}

.foot button:active:not(:disabled) {
  transform: scale(0.97);
}

.ghost {
  background: var(--surface);
  border: 1px solid var(--surface-border);
  color: var(--text);
}

.major {
  background: var(--accent);
  color: var(--on-accent);
}

.major.is-danger {
  background: var(--danger);
  color: #fff;
}

.foot button:disabled {
  opacity: 0.55;
}

.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--dur) var(--ease-smooth);
}

.dialog-enter-active .panel,
.dialog-leave-active .panel {
  transition: transform var(--dur) var(--ease-spring);
}

.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}

.dialog-enter-from .panel,
.dialog-leave-to .panel {
  transform: translateY(16px) scale(0.97);
}
</style>
