<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{
  /** 当前填写的服务器地址，只用来决定展示哪一套说明，不做校验 */
  server: string;
}>();

const open = ref(false);

const isJianguoyun = computed(() => {
  try {
    return new URL(props.server.trim()).host === 'dav.jianguoyun.com';
  } catch {
    return false;
  }
});
</script>

<template>
  <div class="guide" :class="{ 'is-open': open }">
    <button type="button" class="head" :aria-expanded="open" @click="open = !open">
      <span class="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="M9.4 9.3a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.1-2.6 3.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          <circle cx="12" cy="17" r="1" fill="currentColor" />
        </svg>
      </span>
      <span class="head-text">密码怎么填？</span>
      <svg class="chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <Transition name="fold">
      <div v-if="open" class="body">
        <template v-if="isJianguoyun">
          <ol class="steps">
            <li>打开<strong>坚果云网页版</strong>并登录（电脑浏览器、手机 App 里都能操作）</li>
            <li>点右上角<strong>你的账户名</strong> → <strong>账户信息</strong></li>
            <li>左侧选<strong>安全选项</strong> → 找到<strong>第三方应用管理</strong> → 点<strong>添加应用密码</strong></li>
            <li>名称随便填（比如 <span class="m">DoNote</span>）→ 点<strong>生成密码</strong></li>
            <li>复制那串 <strong>16 位密码</strong>，粘回上面的「密码」栏</li>
          </ol>

          <ul class="notes">
            <li>这是<strong>应用密码</strong>，不是你的登录密码。它只能读写文件，登不了坚果云网页。</li>
            <li>随时能在同一个页面<strong>撤销</strong>；撤销后 DoNote 立刻失效。</li>
            <li>如果开了<strong>微信二次验证</strong>，要先关掉 —— WebDAV 不支持它。</li>
            <li>免费版每月有流量额度（上传 1GB / 下载 3GB），日常记笔记够用。</li>
          </ul>

          <div class="links">
            <a class="link" href="https://www.jianguoyun.com/d/home" target="_blank" rel="noreferrer noopener">
              打开坚果云网页版
              <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                <path d="M8 16 16 8M9.5 8H16v6.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </a>
            <a class="link" href="https://help.jianguoyun.com/?p=2064" target="_blank" rel="noreferrer noopener">
              坚果云官方说明
              <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                <path d="M8 16 16 8M9.5 8H16v6.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </a>
          </div>
        </template>

        <ul v-else class="notes is-first">
          <li>填你在<strong>自己的 WebDAV 服务</strong>里的账号密码；多数服务建议在设置里生成一个<strong>应用密码</strong>，比登录密码安全，也能单独撤销。</li>
          <li>地址要写到 WebDAV 的入口，通常以 <span class="m">/dav</span> 或 <span class="m">/remote.php/dav</span> 结尾。服务商文档里会给出这个地址。</li>
          <li>只支持 <strong>http / https</strong>；自建服务器如果是自签证书，需要先让系统信任它。</li>
        </ul>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.guide {
  border: 1px solid var(--surface-border);
  border-radius: var(--r-md);
  background: var(--surface);
  overflow: hidden;
  transition: border-color var(--dur) var(--ease-smooth);
}

.guide.is-open {
  border-color: var(--accent-ring);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
  padding: 12px var(--sp-2);
  font-size: 13px;
  color: var(--text-2);
  text-align: left;
  transition: color var(--dur-fast) var(--ease-smooth);
}

.head:hover,
.guide.is-open .head {
  color: var(--accent);
}

.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent);
  flex: none;
}

.head-text {
  font-weight: 600;
  letter-spacing: 0.01em;
}

.chev {
  margin-left: auto;
  flex: none;
  transition: transform var(--dur) var(--ease-spring);
}

.guide.is-open .chev {
  transform: rotate(180deg);
}

.body {
  padding: 0 var(--sp-2) var(--sp-2);
}

.steps {
  margin: 0;
  padding: 0 0 0 22px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text);
  list-style: decimal;
}

.steps li::marker {
  color: var(--accent);
  font-weight: 600;
}

.steps strong {
  font-weight: 620;
}

.notes {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-1) var(--sp-2) var(--sp-1) 26px;
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  font-size: 12px;
  line-height: 1.85;
  color: var(--text-2);
  list-style: disc;
}

/* 没有步骤列表时，说明块就是第一块内容，去掉上边距 */
.notes.is-first {
  margin-top: 0;
}

.notes strong {
  color: var(--text);
  font-weight: 620;
}

.m {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-border);
  font-family: var(--font-mono);
  font-size: 12px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}

.link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  transition: opacity var(--dur-fast) var(--ease-smooth);
}

.link:hover {
  opacity: 0.75;
}

.fold-enter-active,
.fold-leave-active {
  transition:
    opacity var(--dur) var(--ease-smooth),
    transform var(--dur) var(--ease-smooth);
}

.fold-enter-from,
.fold-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
