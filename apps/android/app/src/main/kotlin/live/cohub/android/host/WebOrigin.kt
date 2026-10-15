package live.cohub.android.host

import android.net.Uri
import androidx.core.net.toUri
import live.cohub.android.BuildConfig

object WebOrigin {
    val uri: Uri = BuildConfig.WEB_ORIGIN.toUri()

    fun contains(url: Uri): Boolean =
        url.scheme == uri.scheme && url.host == uri.host && url.port == uri.port

    fun pathOf(url: Uri): String? {
        if (!contains(url)) return null
        return buildString {
            append(url.encodedPath?.ifEmpty { null } ?: "/")
            url.encodedQuery?.let { append('?').append(it) }
            url.encodedFragment?.let { append('#').append(it) }
        }
    }

    fun urlOf(path: String): String = BuildConfig.WEB_ORIGIN.trimEnd('/') + path

    fun isFirstParty(url: Uri): Boolean {
        val host = url.host ?: return false
        if (url.scheme != uri.scheme) return false
        return host == domain || host.endsWith(".$domain")
    }

    private val domain: String = uri.host.orEmpty().split('.').takeLast(2).joinToString(".")
}
