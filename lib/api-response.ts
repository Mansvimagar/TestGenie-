import { NextResponse } from "next/server";

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json<ApiResponse<T>>({ success: true, data }, { status });
}

export function fail(error: string, status = 400) {
  return NextResponse.json<ApiResponse<never>>({ success: false, error }, { status });
}

export function failWithData<T>(error: string, data: T, status = 400) {
  return NextResponse.json<ApiResponse<T>>({ success: false, error, data }, { status });
}
