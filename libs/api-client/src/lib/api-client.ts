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
    return this.http.get<TResponse>(`${this.baseUrl}${path}`, { params });
  }

  post<TResponse, TBody = unknown>(path: string, body: TBody): Observable<TResponse> {
    return this.http.post<TResponse>(`${this.baseUrl}${path}`, body);
  }

  put<TResponse, TBody = unknown>(path: string, body: TBody): Observable<TResponse> {
    return this.http.put<TResponse>(`${this.baseUrl}${path}`, body);
  }

  delete<TResponse>(path: string): Observable<TResponse> {
    return this.http.delete<TResponse>(`${this.baseUrl}${path}`);
  }

  /** Posts a `FormData` body (multipart), for the one endpoint that accepts a file. */
  upload<TResponse>(path: string, form: FormData): Observable<TResponse> {
    return this.http.post<TResponse>(`${this.baseUrl}${path}`, form);
  }
}
