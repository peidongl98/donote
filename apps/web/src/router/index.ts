import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean;
    guestOnly?: boolean;
    /** 是否显示底部导航（主页面为 true，二级页与公开页为 false） */
    tabs?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { requiresAuth: true, tabs: true },
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
    meta: { requiresAuth: true, tabs: true },
  },
  {
    path: '/folders/:id',
    name: 'folder',
    component: () => import('@/views/FolderDetailView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/shares',
    name: 'shares',
    component: () => import('@/views/SharesView.vue'),
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
    meta: { requiresAuth: true, tabs: true },
  },
  {
    path: '/admin',
    name: 'admin',
    component: () => import('@/views/PlaceholderView.vue'),
    meta: { requiresAuth: true },
  },
  // 公开分享页：不需要登录
  { path: '/s/:slug', name: 'share', component: () => import('@/views/PublicShareView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach((to) => {
  const auth = useAuthStore();

  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.guestOnly && auth.isLoggedIn) {
    return { name: 'home' };
  }
  return true;
});
