import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';

/** Base URL of the API, provided by each application's environment (e.g. `apps/admin`). */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL');

/**
 * Thin typed wrapper over Angular's `HttpClient`. A generated `fetch`-based
 * client was rejected on purpose: it bypasses `HttpInterceptor`s, and that is
 * exactly where the token refresh and the central error handling live (Task
 * 16). Routing every call through this wrapper keeps that seam intact while
 * still giving each endpoint method (see `endpoints.ts`) full request and
 * response types generated from the OpenAPI document.
 *
 * `withCredentials: true` on every call: the refresh token now travels as an
 * httpOnly cookie (see `apps/api/src/lib/http/refresh-cookie.ts`), and
 * without this flag the browser never attaches it, even same-origin, once
 * credentialed mode is off by default on `fetch`/`XMLHttpRequest`. The
 * cookie itself is scoped to `/api/v1/auth` server-side, so setting this
 * everywhere costs nothing on the other ~20 endpoints: there is no cookie
 * for them to send regardless.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  get<TResponse>(path: string, query?: Record<string, string | undefined>): Observable<TResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') params = params.set(key, value);
    }
    return this.http.get<TResponse>(`${this.baseUrl}${path}`, { params, withCredentials: true });
  }

  post<TResponse, TBody = unknown>(path: string, body: TBody): Observable<TResponse> {
    return this.http.post<TResponse>(`${this.baseUrl}${path}`, body, { withCredentials: true });
  }

  put<TResponse, TBody = unknown>(path: string, body: TBody): Observable<TResponse> {
    return this.http.put<TResponse>(`${this.baseUrl}${path}`, body, { withCredentials: true });
  }

  patch<TResponse, TBody = unknown>(path: string, body: TBody): Observable<TResponse> {
    return this.http.patch<TResponse>(`${this.baseUrl}${path}`, body, { withCredentials: true });
  }

  delete<TResponse>(path: string): Observable<TResponse> {
    return this.http.delete<TResponse>(`${this.baseUrl}${path}`, { withCredentials: true });
  }

  /** Downloads a binary response (a receipt PDF, a CSV template) as a `Blob`. */
  getBlob(path: string): Observable<Blob> {
    return this.http.get(`${this.baseUrl}${path}`, { responseType: 'blob', withCredentials: true });
  }

  /** Posts a `FormData` body (multipart), for the endpoints that accept a file. */
  upload<TResponse>(path: string, form: FormData): Observable<TResponse> {
    return this.http.post<TResponse>(`${this.baseUrl}${path}`, form, { withCredentials: true });
  }
}
