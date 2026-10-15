package live.cohub.android.media

import android.Manifest
import android.content.pm.PackageManager
import android.webkit.PermissionRequest
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions
import live.cohub.android.host.WebOrigin

class MediaCapture(private val activity: ComponentActivity) {
    private var pending: Pending? = null

    private val requestPermissions = activity.registerForActivityResult(RequestMultiplePermissions()) { results ->
        val request = pending ?: return@registerForActivityResult
        pending = null
        val granted = request.resources.filter { results[permissionOf(it)] ?: hasPermission(it) }
        if (granted.isEmpty()) request.webRequest.deny() else request.webRequest.grant(granted.toTypedArray())
    }

    fun onRequest(request: PermissionRequest) {
        val resources = request.resources.filter { it in CAPTURE_RESOURCES }
        if (resources.isEmpty() || !WebOrigin.isFirstParty(request.origin)) return request.deny()
        val missing = resources.filterNot(::hasPermission)
        if (missing.isEmpty()) return request.grant(resources.toTypedArray())
        pending?.webRequest?.deny()
        pending = Pending(request, resources)
        requestPermissions.launch(missing.map(::permissionOf).toTypedArray())
    }

    fun onCanceled(request: PermissionRequest) {
        if (pending?.webRequest == request) pending = null
    }

    private fun hasPermission(resource: String) =
        activity.checkSelfPermission(permissionOf(resource)) == PackageManager.PERMISSION_GRANTED

    private class Pending(val webRequest: PermissionRequest, val resources: List<String>)

    private companion object {
        val CAPTURE_RESOURCES = setOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_VIDEO_CAPTURE)

        fun permissionOf(resource: String) =
            if (resource == PermissionRequest.RESOURCE_AUDIO_CAPTURE) Manifest.permission.RECORD_AUDIO else Manifest.permission.CAMERA
    }
}
