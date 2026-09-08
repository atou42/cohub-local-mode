import { env } from "$env/dynamic/public";
import { error } from "@sveltejs/kit";

export function load() {
	if (env.PUBLIC_PERSONAL_NODE_ALPHA !== "true" || env.PUBLIC_API_ORIGIN !== "https://dev2-cohub.atou.cc") {
		error(404, "Not found");
	}
}
