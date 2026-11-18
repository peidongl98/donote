import {
  createRouter,
  createWebHashHistory,
  createWebHistory,
  type RouteRecordRaw,
} from 'vue-router';
import { useWebdavStore } from '@/stores/webdav';

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean;
    guestOnly?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/notes/:id',
    name: 'note',
    component: () => import('@/views/NoteEditView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/folders',
    name: 'folders',
    component: () => import('@/views/FoldersView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/folders/:id',
    name: 'folder',
    component: () => import('@/views/FolderDetailView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/trash',
    name: 'trash',
    component: () => import('@/views/TrashView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { requiresAuth: true },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

/**
 * 鸿蒙壳里页面是 resource://rawfile/www/index.html，不是 http(s)。
 * 这种协议下 history.pushState 改不出可用的路径，刷新/回退就会丢页面；
 * 换成 hash 模式，路由全在 # 后面，文档 URL 不变，资源相对路径也不会跟着移位。
 */
const isRawfileShell = typeof location !== 'undefined' && location.protocol === 'resource:';

export const router = createRouter({
  history: isRawfileShell ? createWebHashHistory() : createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach((to) => {
  const webdav = useWebdavStore();

  if (to.meta.requiresAuth && !webdav.isConnected) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.guestOnly && webdav.isConnected) {
    return { name: 'home' };
  }
  return true;
});
