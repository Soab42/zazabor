package dev.soab.zazabor.cast

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.net.Uri
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/**
 * Zazabor Link's screen. Phone Link: the paired PC, pairing (with the code comparison) and the
 * permissions it may use, asked one at a time. Mirroring: the PCs on this Wi-Fi (and a typed
 * address); tapping one asks for screen capture and starts [MirrorService], and a card on top
 * shows how it's going.
 */
class MainActivity : Activity() {
    companion object {
        private const val REQUEST_PERMISSIONS = 1
        private const val REQUEST_PROJECTION = 2
        private const val REQUEST_LINK_PERMISSION = 3
        /** `adb shell am start -n dev.soab.zazabor.cast/.MainActivity --es address 10.0.2.2:47212` */
        const val EXTRA_ADDRESS = "address"
        /** Phone Link's `mirror.start`: a one-time token LinkService checks (see [LinkService.takeMirror]). */
        const val EXTRA_MIRROR_TOKEN = "mirrorToken"

        /** Whether the screen is showing (LinkService shows prompts here instead of notifying). */
        @Volatile
        var visible = false
            private set
    }

    private lateinit var discovery: Discovery
    private lateinit var pcList: LinearLayout
    private lateinit var emptyHint: TextView
    private lateinit var statusCard: LinearLayout
    private lateinit var statusDot: View
    private lateinit var statusTitle: TextView
    private lateinit var statusDetail: TextView
    private lateinit var statusButton: TextView
    private var pcs: List<Pc> = emptyList()
    private var pending: Pc? = null
    private val onStatus: (MirrorStatus) -> Unit = { showStatus(it) }

    // Phone Link
    private lateinit var linkDiscovery: Discovery
    private var linkPcs: List<Pc> = emptyList()
    private lateinit var linkDot: View
    private lateinit var linkTitle: TextView
    private lateinit var linkDetail: TextView
    private lateinit var linkButtons: LinearLayout
    private lateinit var checklist: LinearLayout
    private var chooser: AlertDialog? = null
    private var chooserList: LinearLayout? = null
    private var codeDialog: AlertDialog? = null
    private var codeShown: LinkStatus.Pairing? = null
    private val onLink: (LinkStatus) -> Unit = { showLink(it) }
    private val onNotice: (String) -> Unit = { Toast.makeText(this, it, Toast.LENGTH_SHORT).show() }

    private fun dp(v: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
    private fun color(id: Int) = getColor(id)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        discovery = Discovery(this) { found ->
            pcs = found
            renderPcs()
        }
        linkDiscovery = Discovery(this, Discovery.LINK) { found ->
            linkPcs = found
            renderChooser()
        }
        setContentView(buildUi())
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val token = intent?.getStringExtra(EXTRA_MIRROR_TOKEN)
        if (token != null) {
            intent.removeExtra(EXTRA_MIRROR_TOKEN)
            getSystemService(android.app.NotificationManager::class.java).cancel(LinkService.NOTIFY_MIRROR)
            LinkService.takeMirror(token)?.let { mirrorTo(it) }
            return
        }
        val address = intent?.getStringExtra(EXTRA_ADDRESS) ?: return
        intent.removeExtra(EXTRA_ADDRESS)
        // Any app can start this screen with an address, so the user confirms where the screen goes.
        val pc = Pc.parse(address) ?: return
        AlertDialog.Builder(this)
            .setTitle("Mirror this screen?")
            .setMessage("Another app asked to show this phone's screen on ${pc.host}:${pc.port}. Only allow it if that's your PC.")
            .setPositiveButton("Mirror") { _, _ -> mirrorTo(pc) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    override fun onStart() {
        super.onStart()
        visible = true
        discovery.start()
        linkDiscovery.start()
        MirrorState.listen(onStatus)
        LinkState.listen(onLink, onNotice)
    }

    override fun onResume() {
        super.onResume()
        // Back from Settings: a permission may have changed.
        renderChecklist()
        if (LinkPrefs(this).paired) LinkService.refresh(this)
    }

    override fun onStop() {
        visible = false
        MirrorState.unlisten(onStatus)
        LinkState.unlisten(onLink, onNotice)
        discovery.stop()
        linkDiscovery.stop()
        super.onStop()
    }

    // ---- mirroring ----

    private fun mirrorTo(pc: Pc) {
        if (MirrorState.status.active) {
            Toast.makeText(this, "Already mirroring. Stop it first.", Toast.LENGTH_SHORT).show()
            return
        }
        pending = pc
        val wanted = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        val asked = getSharedPreferences("cast", MODE_PRIVATE).getBoolean("askedPermissions", false)
        if (wanted.isNotEmpty() && !asked) {
            getSharedPreferences("cast", MODE_PRIVATE).edit().putBoolean("askedPermissions", true).apply()
            requestPermissions(wanted.toTypedArray(), REQUEST_PERMISSIONS)
        } else {
            askForCapture()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode == REQUEST_LINK_PERMISSION) {
            renderChecklist()
            if (LinkPrefs(this).paired) LinkService.refresh(this)
            return
        }
        if (requestCode == REQUEST_PERMISSIONS) {
            // Without the microphone permission the screen still mirrors, just silently.
            askForCapture()
        }
    }

    private fun askForCapture() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        val intent = if (Build.VERSION.SDK_INT >= 34) {
            manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            manager.createScreenCaptureIntent()
        }
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQUEST_PROJECTION)
    }

    @Deprecated("Activity result API without AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_PROJECTION) return
        val pc = pending ?: return
        pending = null
        if (resultCode == RESULT_OK && data != null) {
            remember(pc)
            MirrorService.start(this, pc, resultCode, data)
        } else {
            Toast.makeText(this, "Screen capture wasn't allowed", Toast.LENGTH_SHORT).show()
        }
    }

    private fun remember(pc: Pc) {
        if (pc.key.startsWith("address:")) {
            getSharedPreferences("cast", MODE_PRIVATE).edit().putString("lastAddress", pc.address).apply()
        }
    }

    /** A typed PC address: to mirror to, or (`forLink`) to pair Phone Link with. */
    private fun askForAddress(forLink: Boolean = false) {
        val prefs = getSharedPreferences("cast", MODE_PRIVATE)
        val field = EditText(this).apply {
            hint = if (forLink) "192.168.1.20 or 192.168.1.20:${Link.DEFAULT_PORT}" else "192.168.1.20 or 192.168.1.20:47212"
            setText(if (forLink) LinkPrefs(this@MainActivity).host ?: "" else prefs.getString("lastAddress", ""))
            setSelection(text.length)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setSingleLine()
            setTextColor(color(R.color.text))
            setHintTextColor(color(R.color.muted))
            backgroundTintList = ColorStateList.valueOf(color(R.color.accent))
        }
        val frame = FrameLayout(this).apply {
            setPadding(dp(22), dp(8), dp(22), 0)
            addView(field)
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle("Enter the PC's address")
            .setMessage(
                if (forLink) "Zazabor Home shows it in Phone, while Phone Link is on." else "Zazabor Home shows it under Video → Network Streams → Cast to this PC.",
            )
            .setView(frame)
            .setPositiveButton(if (forLink) "Pair" else "Mirror", null)
            .setNegativeButton("Cancel", null)
            .create()
        val go = {
            val typed = field.text.toString()
            val pc = Pc.parse(typed)
            if (pc == null) {
                field.error = "Type an IP address, optionally with :port"
            } else if (forLink) {
                dialog.dismiss()
                val port = if (typed.trim().removePrefix("http://").contains(':')) pc.port else Link.DEFAULT_PORT
                LinkService.pair(this, pc.host, port, pc.host)
            } else {
                dialog.dismiss()
                mirrorTo(pc)
            }
        }
        field.setOnEditorActionListener { _, _, _ -> go(); true }
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { go() } }
        dialog.window?.setBackgroundDrawable(rounded(color(R.color.surface), dp(24).toFloat()))
        dialog.show()
    }

    // ---- the screen ----

    private fun rounded(fill: Int, radius: Float, stroke: Int? = null): GradientDrawable =
        GradientDrawable().apply {
            setColor(fill)
            cornerRadius = radius
            if (stroke != null) setStroke(dp(1), stroke)
        }

    private fun pressable(fill: Int, radius: Float, stroke: Int? = null) =
        RippleDrawable(ColorStateList.valueOf(0x22FFFFFF), rounded(fill, radius, stroke), rounded(-0x1, radius))

    private fun text(size: Float, colorId: Int, bold: Boolean = false) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(color(colorId))
        if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }

    private fun icon(res: Int, sizeDp: Int) = ImageView(this).apply {
        setImageResource(res)
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
    }

    private fun buildUi(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(32))
        }

        // Header
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher)
            layoutParams = LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginEnd = dp(14) }
        })
        header.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text(24f, R.color.text, bold = true).apply { text = getString(R.string.app_name) })
            addView(text(14f, R.color.muted).apply { text = "This phone on your PC" })
        })
        column.addView(header)

        // Status
        statusCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(color(R.color.surface), dp(20).toFloat(), color(R.color.outline))
            setPadding(dp(18), dp(16), dp(18), dp(16))
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(24) }
        }
        val statusRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        statusDot = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(10), dp(10)).apply { marginEnd = dp(10) }
        }
        statusTitle = text(17f, R.color.text, bold = true)
        statusRow.addView(statusDot)
        statusRow.addView(statusTitle, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        statusCard.addView(statusRow)
        statusDetail = text(14f, R.color.muted).apply { setPadding(dp(20), dp(4), 0, 0) }
        statusCard.addView(statusDetail)
        statusButton = text(15f, R.color.background, bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(18), dp(10), dp(18), dp(10))
            background = pressable(color(R.color.accent), dp(22).toFloat())
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(14)
                marginStart = dp(20)
            }
        }
        statusCard.addView(statusButton)
        column.addView(statusCard)

        buildLink(column)

        // PCs
        val section = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), dp(32), dp(4), dp(10))
        }
        section.addView(text(13f, R.color.muted, bold = true).apply {
            text = "MIRROR TO A PC ON THIS WI-FI"
            letterSpacing = 0.08f
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        section.addView(ProgressBar(this, null, android.R.attr.progressBarStyleSmall).apply {
            indeterminateTintList = ColorStateList.valueOf(color(R.color.accent))
            layoutParams = LinearLayout.LayoutParams(dp(16), dp(16))
        })
        column.addView(section)

        pcList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(pcList)
        emptyHint = text(14f, R.color.muted).apply {
            text = "Looking for PCs…\nIn Zazabor Home, turn on Video → Network Streams → Cast to this PC. The phone and the PC need to be on the same Wi-Fi."
            setLineSpacing(0f, 1.25f)
            background = rounded(color(R.color.surface), dp(18).toFloat())
            setPadding(dp(18), dp(16), dp(18), dp(16))
        }
        column.addView(emptyHint)

        column.addView(text(13f, R.color.muted, bold = true).apply {
            text = "OR"
            letterSpacing = 0.08f
            setPadding(dp(4), dp(24), dp(4), dp(10))
        })
        column.addView(row(R.drawable.ic_edit, "Enter an address", "For a PC that isn't listed") { askForAddress() })
        val last = getSharedPreferences("cast", MODE_PRIVATE).getString("lastAddress", null)
        if (last != null) {
            column.addView(row(R.drawable.ic_history, last, "Last used") { Pc.parse(last)?.let { mirrorTo(it) } }.apply {
                (layoutParams as LinearLayout.LayoutParams).topMargin = dp(10)
            })
        }
        column.addView(text(12f, R.color.muted).apply {
            text = "Mirroring sends the screen and the sound apps play. Calls and some apps keep their sound private."
            setLineSpacing(0f, 1.2f)
            setPadding(dp(4), dp(28), dp(4), 0)
        })

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(color(R.color.background))
            addView(column)
        }
        // Android 15 draws behind the system bars; keep the content clear of them.
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        return scroll
    }

    private fun row(iconRes: Int, title: String, subtitle: String, fill: Int = R.color.surface, onClick: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = pressable(color(fill), dp(18).toFloat())
            setPadding(dp(14), dp(14), dp(14), dp(14))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            isClickable = true
            setOnClickListener { onClick() }
            addView(FrameLayout(this@MainActivity).apply {
                background = rounded(color(R.color.accent_soft), dp(14).toFloat())
                layoutParams = LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginEnd = dp(14) }
                addView(icon(iconRes, 22).apply { layoutParams = FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER) })
            })
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(text(16f, R.color.text, bold = true).apply {
                    text = title
                    maxLines = 1
                })
                addView(text(13f, R.color.muted).apply {
                    text = subtitle
                    maxLines = 1
                })
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(icon(R.drawable.ic_chevron, 22))
        }

    private fun renderPcs() {
        pcList.removeAllViews()
        for ((i, pc) in pcs.withIndex()) {
            pcList.addView(row(R.drawable.ic_monitor, pc.name, pc.address) { mirrorTo(pc) }.apply {
                if (i > 0) (layoutParams as LinearLayout.LayoutParams).topMargin = dp(10)
            })
        }
        emptyHint.visibility = if (pcs.isEmpty()) View.VISIBLE else View.GONE
    }

    private fun showStatus(status: MirrorStatus) {
        val (dot, title, detail, button) = when (status) {
            MirrorStatus.Idle -> {
                statusCard.visibility = View.GONE
                return
            }
            is MirrorStatus.Connecting -> Quad(R.color.warn, "Connecting…", status.pc, "Cancel")
            is MirrorStatus.Waiting -> Quad(R.color.warn, "Waiting for the PC to allow…", "Answer the prompt on ${status.pc}", "Cancel")
            is MirrorStatus.Mirroring -> Quad(
                R.color.good, "Mirroring to ${status.pc}",
                if (status.audio) "Screen and sound" else "Screen only (no sound permission)", "Stop",
            )
            is MirrorStatus.Ended -> Quad(R.color.bad, "Disconnected", status.reason, "Dismiss")
        }
        statusCard.visibility = View.VISIBLE
        statusDot.background = rounded(color(dot), dp(5).toFloat())
        statusTitle.text = title
        statusDetail.text = detail
        statusButton.text = button
        statusButton.setOnClickListener {
            if (status is MirrorStatus.Ended) MirrorState.set(MirrorStatus.Idle) else MirrorService.stop(this)
        }
    }

    // ---- Phone Link ----

    private fun sectionTitle(title: String) = text(13f, R.color.muted, bold = true).apply {
        text = title
        letterSpacing = 0.08f
    }

    private fun buildLink(column: LinearLayout) {
        column.addView(sectionTitle("PHONE LINK").apply { setPadding(dp(4), dp(28), dp(4), dp(10)) })
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(color(R.color.surface), dp(20).toFloat(), color(R.color.outline))
            setPadding(dp(18), dp(16), dp(18), dp(16))
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        linkDot = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(10), dp(10)).apply { marginEnd = dp(10) }
        }
        linkTitle = text(17f, R.color.text, bold = true)
        row.addView(linkDot)
        row.addView(linkTitle, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        card.addView(row)
        linkDetail = text(14f, R.color.muted).apply {
            setPadding(dp(20), dp(4), 0, 0)
            setLineSpacing(0f, 1.2f)
        }
        card.addView(linkDetail)
        linkButtons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(20), dp(14), 0, 0)
        }
        card.addView(linkButtons)
        column.addView(card)

        column.addView(sectionTitle("ALLOW ON THIS PHONE").apply { setPadding(dp(4), dp(24), dp(4), dp(4)) })
        column.addView(text(13f, R.color.muted).apply {
            text = "Each one is optional. The PC only gets what you allow here."
            setPadding(dp(4), 0, dp(4), dp(10))
        })
        checklist = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(color(R.color.surface), dp(18).toFloat())
        }
        column.addView(checklist)
        renderChecklist()
    }

    private fun pill(label: String, primary: Boolean, onClick: () -> Unit) =
        text(15f, if (primary) R.color.background else R.color.text, bold = true).apply {
            text = label
            gravity = Gravity.CENTER
            setPadding(dp(18), dp(10), dp(18), dp(10))
            background = if (primary) {
                pressable(color(R.color.accent), dp(22).toFloat())
            } else {
                pressable(color(R.color.surface_high), dp(22).toFloat(), color(R.color.outline))
            }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(10) }
            setOnClickListener { onClick() }
        }

    private fun showLink(given: LinkStatus) {
        val prefs = LinkPrefs(this)
        var status = given
        if (status is LinkStatus.Unpaired && prefs.paired) {
            // Paired, but the service isn't running (yet): start it.
            status = LinkStatus.Waiting(prefs.pcName, "Starting…")
            LinkService.start(this)
        }
        val (dot, title, detail) = when (status) {
            LinkStatus.Unpaired -> Triple(
                R.color.muted, "Not linked",
                "See this phone's texts, calls, photos, files and notifications in Zazabor Home on your PC, and send texts and files from there.",
            )
            is LinkStatus.Waiting -> Triple(R.color.warn, status.pc, status.detail)
            is LinkStatus.Pairing -> Triple(
                R.color.warn, "Pairing with ${status.pc}…",
                if (status.code != null) "Compare the code on both screens" else "Confirm the code on the PC",
            )
            is LinkStatus.Linked -> Triple(R.color.good, "Linked to ${status.pc}", "Texts, calls, photos, files and notifications show on ${status.pc}.")
            is LinkStatus.Problem -> Triple(R.color.bad, status.pc, status.detail)
        }
        linkDot.background = rounded(color(dot), dp(5).toFloat())
        linkTitle.text = title
        linkDetail.text = detail
        linkButtons.removeAllViews()
        when (status) {
            LinkStatus.Unpaired -> linkButtons.addView(pill("Pair with a PC", true) { choosePc() })
            is LinkStatus.Pairing -> linkButtons.addView(pill("Cancel", false) { LinkService.cancelPairing() })
            is LinkStatus.Problem -> {
                linkButtons.addView(
                    if (status.repair) pill("Pair again", true) { pairAgain() } else pill("Try again", true) { LinkService.retry(this) },
                )
                linkButtons.addView(pill("Forget", false) { confirmForget() })
            }
            else -> linkButtons.addView(pill("Forget", false) { confirmForget() })
        }
        showCode(status)
    }

    /** The numeric comparison: both screens show the same six digits. */
    private fun showCode(status: LinkStatus) {
        val pairing = status as? LinkStatus.Pairing
        val code = pairing?.code
        if (code == null) {
            codeDialog?.dismiss()
            codeDialog = null
            codeShown = null
            return
        }
        if (codeShown == pairing && codeDialog?.isShowing == true) return
        codeDialog?.dismiss()
        chooser?.dismiss()
        val view = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(8), dp(24), 0)
            addView(text(15f, R.color.muted).apply { text = "Does ${pairing.pc} show this code?" })
            addView(text(40f, R.color.text, bold = true).apply {
                text = ZlnkCrypto.formatCode(code)
                letterSpacing = 0.08f
                gravity = Gravity.CENTER
                setPadding(0, dp(18), 0, dp(8))
            })
            addView(text(13f, R.color.muted).apply {
                text = "Pair only if the numbers match."
                gravity = Gravity.CENTER
            })
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle("Pair with ${pairing.pc}?")
            .setView(view)
            .setPositiveButton("Pair") { _, _ -> LinkService.answerPairing(true) }
            .setNegativeButton("Cancel") { _, _ -> LinkService.answerPairing(false) }
            .setCancelable(false)
            .create()
        dialog.window?.setBackgroundDrawable(rounded(color(R.color.surface), dp(24).toFloat()))
        dialog.show()
        codeDialog = dialog
        codeShown = pairing
    }

    /** The Phone Link PCs on this Wi-Fi, and a typed address. */
    /** The PC forgot this phone: pair with it again where it was last seen, else pick a PC. */
    private fun pairAgain() {
        val prefs = LinkPrefs(this)
        val host = prefs.host
        if (host.isNullOrBlank()) choosePc() else LinkService.pair(this, host, prefs.port, prefs.pcName)
    }

    private fun choosePc() {
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val frame = ScrollView(this).apply {
            setPadding(dp(16), dp(8), dp(16), 0)
            addView(list)
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle("Pair with a PC")
            .setView(frame)
            .setNegativeButton("Cancel", null)
            .create()
        dialog.setOnDismissListener {
            if (chooser === dialog) {
                chooser = null
                chooserList = null
            }
        }
        dialog.window?.setBackgroundDrawable(rounded(color(R.color.surface), dp(24).toFloat()))
        chooser = dialog
        chooserList = list
        renderChooser()
        dialog.show()
    }

    private fun renderChooser() {
        val list = chooserList ?: return
        list.removeAllViews()
        if (linkPcs.isEmpty()) {
            list.addView(text(14f, R.color.muted).apply {
                text = "Looking for PCs…\nIn Zazabor Home on the PC, open Phone and turn on Phone Link. Both need to be on the same Wi-Fi."
                setLineSpacing(0f, 1.25f)
                setPadding(dp(8), dp(4), dp(8), dp(12))
            })
        }
        for (pc in linkPcs) {
            list.addView(row(R.drawable.ic_monitor, pc.name, pc.host, R.color.surface_high) {
                chooser?.dismiss()
                LinkService.pair(this, pc.host, pc.port, pc.name)
            }.apply { (layoutParams as LinearLayout.LayoutParams).bottomMargin = dp(10) })
        }
        list.addView(row(R.drawable.ic_edit, "Enter an address", "For a PC that isn't listed", R.color.surface_high) {
            chooser?.dismiss()
            askForAddress(forLink = true)
        })
    }

    private fun confirmForget() {
        val pc = LinkPrefs(this).pcName
        val dialog = AlertDialog.Builder(this)
            .setTitle("Forget $pc?")
            .setMessage("This phone stops linking to $pc. To link again, pair again.")
            .setPositiveButton("Forget") { _, _ -> LinkService.forget(this) }
            .setNegativeButton("Cancel", null)
            .create()
        dialog.window?.setBackgroundDrawable(rounded(color(R.color.surface), dp(24).toFloat()))
        dialog.show()
    }

    // ---- the permission checklist ----

    private class Need(val title: String, val detail: String, val granted: () -> Boolean, val ask: () -> Unit)

    private fun granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun runtime(title: String, detail: String, vararg permissions: String) =
        Need(title, detail, { permissions.any { granted(it) } }) { requestOne(arrayOf(*permissions)) }

    private fun needs(): List<Need> = buildList {
        if (Build.VERSION.SDK_INT >= 33) add(runtime("Notifications", "The link's status, pairing codes and Ring my phone", Manifest.permission.POST_NOTIFICATIONS))
        add(runtime("Read texts", "Your conversations on the PC", Manifest.permission.READ_SMS))
        add(runtime("New texts", "Texts show on the PC as they arrive", Manifest.permission.RECEIVE_SMS))
        add(runtime("Send texts", "Write and reply from the PC", Manifest.permission.SEND_SMS))
        add(runtime("Call history", "Recent calls on the PC", Manifest.permission.READ_CALL_LOG))
        add(runtime("Contacts", "Names and photos instead of numbers", Manifest.permission.READ_CONTACTS))
        add(runtime("Phone status", "Signal, network and who's calling", Manifest.permission.READ_PHONE_STATE))
        add(runtime("Make calls", "Call a number from the PC", Manifest.permission.CALL_PHONE))
        add(runtime("Answer and end calls", "Pick up or hang up from the PC", Manifest.permission.ANSWER_PHONE_CALLS))
        add(Need("Phone notifications", "See, answer and dismiss them on the PC", { NotifListener.enabled(this@MainActivity) }) { openNotificationAccess() })
        if (Build.VERSION.SDK_INT >= 33) {
            add(runtime("Photos and videos", "Your recent photos on the PC", Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO))
        } else {
            add(runtime("Photos and videos", "Your recent photos on the PC", Manifest.permission.READ_EXTERNAL_STORAGE))
        }
        if (Build.VERSION.SDK_INT >= 30) {
            add(Need("All files", "Browse this phone's files from the PC", { PhoneFiles.allAccess(this@MainActivity) }) { openAllFiles() })
        } else {
            add(runtime("All files", "Browse this phone's files from the PC", Manifest.permission.WRITE_EXTERNAL_STORAGE))
        }
        add(Need("Stay linked in the background", "Keeps the link while the screen is off", {
            getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        }) { askBattery() })
    }

    private fun renderChecklist() {
        if (!::checklist.isInitialized) return
        checklist.removeAllViews()
        val items = needs()
        for ((i, need) in items.withIndex()) {
            val on = need.granted()
            checklist.addView(checkRow(need.title, need.detail, i > 0) {
                addView(
                    if (on) text(14f, R.color.good, bold = true).apply { text = "On" } else pill("Allow", true) { need.ask() }.apply {
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                        setPadding(dp(14), dp(7), dp(14), dp(7))
                        (layoutParams as LinearLayout.LayoutParams).marginEnd = 0
                    },
                )
            }.apply {
                setOnClickListener { if (on) openAppSettings() else need.ask() }
            })
        }
        val prefs = LinkPrefs(this)
        checklist.addView(checkRow("Share the clipboard", "Text copied on the PC lands here; send this phone's from the link notification", true) {
            addView(Switch(this@MainActivity).apply {
                isChecked = prefs.clip
                thumbTintList = ColorStateList.valueOf(color(if (prefs.clip) R.color.accent else R.color.muted))
                setOnCheckedChangeListener { _, on ->
                    prefs.clip = on
                    thumbTintList = ColorStateList.valueOf(color(if (on) R.color.accent else R.color.muted))
                    if (prefs.paired) LinkService.refresh(this@MainActivity)
                }
            })
        })
    }

    private fun checkRow(title: String, detail: String, divider: Boolean, end: LinearLayout.() -> Unit): LinearLayout {
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = RippleDrawable(ColorStateList.valueOf(0x22FFFFFF), null, rounded(-0x1, dp(18).toFloat()))
            isClickable = true
        }
        if (divider) {
            wrap.addView(View(this).apply {
                setBackgroundColor(color(R.color.outline))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply {
                    marginStart = dp(16)
                    marginEnd = dp(16)
                }
            })
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        row.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text(15f, R.color.text, bold = true).apply { text = title })
            addView(text(13f, R.color.muted).apply {
                text = detail
                setPadding(0, dp(2), dp(10), 0)
            })
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.end()
        wrap.addView(row)
        return wrap
    }

    /** One permission (or one dialog's group) at a time; after a "don't ask again", its settings page. */
    private fun requestOne(permissions: Array<String>) {
        val prefs = getSharedPreferences("link", MODE_PRIVATE)
        val key = "asked_" + permissions[0]
        if (prefs.getBoolean(key, false) && permissions.none { shouldShowRequestPermissionRationale(it) }) {
            Toast.makeText(this, "Allow it under Permissions", Toast.LENGTH_LONG).show()
            openAppSettings()
            return
        }
        prefs.edit().putBoolean(key, true).apply()
        requestPermissions(permissions, REQUEST_LINK_PERMISSION)
    }

    private fun openAppSettings() {
        tryStart(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
    }

    private fun openNotificationAccess() {
        val component = ComponentName(this, NotifListener::class.java)
        val detail = if (Build.VERSION.SDK_INT >= 30) {
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component.flattenToString())
        } else {
            null
        }
        if (detail == null || !tryStart(detail)) tryStart(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    }

    private fun openAllFiles() {
        if (Build.VERSION.SDK_INT < 30) return
        if (!tryStart(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.fromParts("package", packageName, null)))) {
            tryStart(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
        }
    }

    @android.annotation.SuppressLint("BatteryLife")
    private fun askBattery() {
        if (!tryStart(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.fromParts("package", packageName, null)))) {
            tryStart(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun tryStart(intent: Intent): Boolean = try {
        startActivity(intent)
        true
    } catch (_: Exception) {
        false
    }

    private data class Quad(val dot: Int, val title: String, val detail: String, val button: String)
}
