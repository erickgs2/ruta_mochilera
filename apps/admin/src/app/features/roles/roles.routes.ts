import { Component } from '@angular/core';
import type { Routes } from '@angular/router';

/**
 * Placeholder screen -- Task 18 replaces this with the real role editor.
 * It only needs to exist so `role.view`-gated navigation in the Task 16
 * shell has somewhere to land.
 */
@Component({ selector: 'rm-roles-placeholder', standalone: true, template: `<p>Roles</p>` })
class RolesPlaceholderComponent {}

export const rolesRoutes: Routes = [{ path: '', component: RolesPlaceholderComponent }];
