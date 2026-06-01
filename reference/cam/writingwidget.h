// This file is a part of "Candle" application (hjLabs.in fork).
// Writing-mode panel — type text, generate pen-plotter G-code with a
// single-stroke vector font from the shared cadcam core.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef WRITINGWIDGET_H
#define WRITINGWIDGET_H

#include <QWidget>
#include <QStringList>

#include "cadcam/strokefont.h"

class QComboBox;
class QDoubleSpinBox;
class QPlainTextEdit;
class QLabel;
class QCheckBox;
class QTimer;

// A dockable panel that turns typed text into single-stroke pen polylines,
// lays them out with a chosen char height / spacing / alignment, runs them
// through the cadcam engrave + emitter (Pen Z mode), and hands the program to
// the main window's existing visualizer/sender via programGenerated().
class WritingWidget : public QWidget
{
    Q_OBJECT

public:
    explicit WritingWidget(QWidget *parent = nullptr);

    // Per-panel zoom percentage (100 == 1.0x). Used by the dock title bar.
    int zoomPercent() const { return int(qRound(m_zoom * 100.0)); }

public slots:
    // Per-panel zoom controls, driven from the dock title bar.
    void zoomIn();
    void zoomOut();
    void zoomReset();

signals:
    void programGenerated(const QStringList &lines);
    void statusMessage(const QString &message);
    // Emitted whenever the panel zoom changes (percent, 100 == 1.0x).
    void zoomChanged(int percent);

private slots:
    void loadCustomFont();
    void generate();
    void scheduleLivePreview();

private:
    cadcam::StrokeFont m_font;

    QPlainTextEdit *m_text = nullptr;
    QDoubleSpinBox *m_charHeight = nullptr;
    QDoubleSpinBox *m_lineSpacing = nullptr;
    QDoubleSpinBox *m_letterSpacing = nullptr;
    QDoubleSpinBox *m_originX = nullptr;
    QDoubleSpinBox *m_originY = nullptr;
    QComboBox *m_align = nullptr;
    QDoubleSpinBox *m_penUpZ = nullptr;
    QDoubleSpinBox *m_penDownZ = nullptr;
    QDoubleSpinBox *m_feed = nullptr;
    QLabel *m_fontLabel = nullptr;
    QLabel *m_info = nullptr;
    QPlainTextEdit *m_preview = nullptr;
    QCheckBox *m_livePreview = nullptr;
    QTimer *m_liveTimer = nullptr;

    // Per-panel zoom: scales this widget's subtree font via a widget stylesheet
    // font-size (overrides the app-wide QSS font-size for this panel only).
    double m_zoom = 1.0;
    void applyZoom();
};

#endif // WRITINGWIDGET_H
